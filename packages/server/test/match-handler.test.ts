/**
 * The match handler: who is told what, and what chat is allowed to carry.
 *
 * Unit-level, against a fake connection, so the fan-out rules are asserted without a socket.
 * The end-to-end path is in gateway.test.ts.
 */

import {
  deployMatch,
  generateMap,
  CHAT_BURST,
  CHAT_MAX_LENGTH,
  CHAT_WINDOW_MS,
  type BoatTemplate,
  type DeployingPlayer,
  type MatchState,
  type ServerMessage,
} from '@seg/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { MatchHandler } from '../src/match/handler.js';
import { MatchStore } from '../src/match/store.js';
import { ConnectionRegistry, type PlayerConnection } from '../src/realtime/connections.js';

const BOAT: BoatTemplate = { name: 'S-01', hull: 'light', modules: [] };

function seat(
  accountId: string,
  position: DeployingPlayer['position'],
  boats: readonly BoatTemplate[] = [BOAT],
): DeployingPlayer {
  return { accountId, username: accountId, position, boats };
}

function match(): MatchState {
  return deployMatch({
    matchId: 'm1',
    mode: 'objective-capture',
    map: generateMap('empty', { seed: 5, mapSize: 'small' }),
    startedAt: 1_000,
    players: [
      seat('host', 'team1'),
      seat('mate', 'team1'),
      seat('foe', 'team2'),
      seat('watcher', 'spectator', []),
    ],
  });
}

interface Fake extends PlayerConnection {
  readonly sent: ServerMessage[];
  clear(): void;
  /** Every chat line this connection was given, in order. */
  lines(): string[];
}

function fake(accountId: string): Fake {
  const sent: ServerMessage[] = [];
  return {
    accountId,
    username: accountId,
    sent,
    send: (message) => sent.push(message),
    clear: () => {
      sent.length = 0;
    },
    lines: () =>
      sent.flatMap((message) => (message.t === 'chat.message' ? [message.entry.text] : [])),
  };
}

let now = 10_000;
let store: MatchStore;
let connections: ConnectionRegistry;
let handler: MatchHandler;
let host: Fake;
let mate: Fake;
let foe: Fake;
let watcher: Fake;

beforeEach(() => {
  now = 10_000;
  store = new MatchStore();
  connections = new ConnectionRegistry();
  handler = new MatchHandler({ store, connections, clock: () => now });

  [host, mate, foe, watcher] = [fake('host'), fake('mate'), fake('foe'), fake('watcher')];
  for (const connection of [host, mate, foe, watcher]) connections.add(connection);
});

describe('beginning a match', () => {
  it('sends every player their own setup and a first frame', () => {
    store.store(match());
    handler.begin('m1');

    for (const connection of [host, mate, foe]) {
      expect(connection.sent.map((m) => m.t)).toEqual(['match.state', 'match.view']);
    }

    const [state] = host.sent;
    if (state?.t !== 'match.state') throw new Error('no setup');
    expect(state.setup.you.team).toBe('team1');
    expect(state.setup.fleet.every((boat) => boat.team === 'team1')).toBe(true);

    // And the other side is told about its own, which is a different set of boats.
    const rival = foe.sent[0];
    if (rival?.t !== 'match.state') throw new Error('no setup');
    expect(rival.setup.fleet.map((b) => b.id)).not.toEqual(state.setup.fleet.map((b) => b.id));
  });

  it('sends a spectator the map and the roster, but no fleet', () => {
    store.store(match());
    handler.begin('m1');

    const state = watcher.sent[0];
    if (state?.t !== 'match.state') throw new Error('no setup');
    expect(state.setup.fleet).toEqual([]);
    expect(state.setup.map.extents.width).toBeGreaterThan(0);
    expect(state.setup.players).toHaveLength(4);
  });

  it('says nothing to an account with no socket', () => {
    store.store(match());
    connections.remove(foe);
    handler.begin('m1');

    expect(foe.sent).toEqual([]);
    expect(host.sent.length).toBeGreaterThan(0);
  });
});

describe('reconnecting', () => {
  beforeEach(() => {
    store.store(match());
  });

  it('re-sends the whole picture, including the chat that was missed', () => {
    handler.handle(host, { t: 'chat.send', scope: 'team', text: 'contact west' });
    handler.detach(mate.accountId);
    mate.clear();

    handler.attach(mate);

    expect(mate.sent.map((m) => m.t)).toEqual(['match.state', 'match.view', 'chat.message']);
    expect(mate.lines()).toEqual(['contact west']);
    expect(store.find('m1')?.players.find((p) => p.accountId === 'mate')?.connected).toBe(true);
  });

  it('holds the seat and the boats while a player is away', () => {
    handler.detach('host');

    const state = store.find('m1');
    expect(state?.players.find((p) => p.accountId === 'host')?.connected).toBe(false);
    expect(state?.boats.filter((boat) => boat.owner === 'host')).toHaveLength(1);
  });

  it('says nothing to a connection whose account is in no match', () => {
    const stranger = fake('stranger');
    handler.attach(stranger);

    expect(stranger.sent).toEqual([]);
  });
});

describe('chat', () => {
  beforeEach(() => {
    store.store(match());
    for (const connection of [host, mate, foe, watcher]) connection.clear();
  });

  it('keeps a team line inside the team, and lets spectators read it', () => {
    handler.handle(host, { t: 'chat.send', scope: 'team', text: 'contact west' });

    expect(host.lines()).toEqual(['contact west']);
    expect(mate.lines()).toEqual(['contact west']);
    expect(watcher.lines()).toEqual(['contact west']);
    expect(foe.lines()).toEqual([]);
  });

  it('lets an all line reach everyone', () => {
    handler.handle(host, { t: 'chat.send', scope: 'all', text: 'good luck' });

    for (const connection of [host, mate, foe, watcher]) {
      expect(connection.lines()).toEqual(['good luck']);
    }
  });

  it('stamps the sender from the connection, never from the message', () => {
    handler.handle(foe, { t: 'chat.send', scope: 'all', text: 'hello' });

    const message = foe.sent.find((m) => m.t === 'chat.message');
    if (message?.t !== 'chat.message') throw new Error('no line');
    expect(message.entry.from).toBe('foe');
    expect(message.entry.username).toBe('foe');
    expect(message.entry.team).toBe('team2');
    expect(message.entry.at).toBe(now);
    expect(message.entry.id).toBe(1);
  });

  it('refuses a channel the speaker is not on', () => {
    handler.handle(host, { t: 'chat.send', scope: 'spectator', text: 'sneaking in' });
    handler.handle(watcher, { t: 'chat.send', scope: 'team', text: 'over there' });

    for (const connection of [host, watcher]) {
      const rejected = connection.sent.find((m) => m.t === 'chat.rejected');
      if (rejected?.t !== 'chat.rejected') throw new Error('not rejected');
      expect(rejected.problem).toBe('wrong_scope');
    }
    expect(mate.lines()).toEqual([]);
  });

  it('gives the observers a channel of their own', () => {
    handler.handle(watcher, { t: 'chat.send', scope: 'spectator', text: 'nice shot' });

    expect(watcher.lines()).toEqual(['nice shot']);
    expect(host.lines()).toEqual([]);
    expect(foe.lines()).toEqual([]);
  });

  it('normalizes and refuses what is left of an empty or oversized line', () => {
    handler.handle(host, { t: 'chat.send', scope: 'team', text: '   ' });
    handler.handle(host, { t: 'chat.send', scope: 'team', text: 'x'.repeat(CHAT_MAX_LENGTH + 1) });

    expect(host.sent.filter((m) => m.t === 'chat.rejected')).toHaveLength(2);
    expect(mate.lines()).toEqual([]);
  });

  it('collapses a line the client did not normalize', () => {
    handler.handle(host, { t: 'chat.send', scope: 'team', text: '  going   deep  ' });

    expect(mate.lines()).toEqual(['going deep']);
  });

  it('rate limits a burst and lets the window slide', () => {
    for (let i = 0; i < CHAT_BURST; i += 1) {
      handler.handle(host, { t: 'chat.send', scope: 'team', text: `line ${String(i)}` });
    }
    expect(mate.lines()).toHaveLength(CHAT_BURST);

    handler.handle(host, { t: 'chat.send', scope: 'team', text: 'one too many' });
    const rejected = host.sent.find((m) => m.t === 'chat.rejected');
    if (rejected?.t !== 'chat.rejected') throw new Error('not rejected');
    expect(rejected.problem).toBe('rate_limited');
    expect(mate.lines()).toHaveLength(CHAT_BURST);

    // The window is a sliding one, so waiting it out restores the allowance.
    now += CHAT_WINDOW_MS;
    handler.handle(host, { t: 'chat.send', scope: 'team', text: 'still here' });
    expect(mate.lines()).toHaveLength(CHAT_BURST + 1);
  });

  it('limits per account rather than globally', () => {
    for (let i = 0; i < CHAT_BURST + 1; i += 1) {
      handler.handle(host, { t: 'chat.send', scope: 'all', text: `host ${String(i)}` });
    }
    handler.handle(foe, { t: 'chat.send', scope: 'all', text: 'unaffected' });

    expect(foe.sent.some((m) => m.t === 'chat.rejected')).toBe(false);
    expect(mate.lines().at(-1)).toBe('unaffected');
  });

  it('ignores a line from someone who is not in a match', () => {
    const stranger = fake('stranger');
    connections.add(stranger);

    handler.handle(stranger, { t: 'chat.send', scope: 'all', text: 'anyone there' });

    expect(stranger.sent).toEqual([]);
    expect(host.lines()).toEqual([]);
  });
});
