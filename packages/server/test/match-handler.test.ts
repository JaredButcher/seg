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
  FIELD_MAP_HZ,
  SIM_TICK_HZ,
  type BoatTemplate,
  type DeployingPlayer,
  type MatchState,
  type ServerMessage,
  type Vec2,
} from '@seg/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { MatchHandler } from '../src/match/handler.js';
import { MatchStore } from '../src/match/store.js';
import { ConnectionRegistry, type PlayerConnection } from '../src/realtime/connections.js';

const BOAT: BoatTemplate = { name: 'S-01', hull: 'light', modules: [] };

/** Sim ticks between field payloads, as `MatchHandler` derives it. */
const FIELD_TICKS = Math.max(1, Math.round(SIM_TICK_HZ / FIELD_MAP_HZ));

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
    store.store(match(), 'Test Lobby');
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
    store.store(match(), 'Test Lobby');
    handler.begin('m1');

    const state = watcher.sent[0];
    if (state?.t !== 'match.state') throw new Error('no setup');
    expect(state.setup.fleet).toEqual([]);
    expect(state.setup.map.extents.width).toBeGreaterThan(0);
    expect(state.setup.players).toHaveLength(4);
  });

  it('says nothing to an account with no socket', () => {
    store.store(match(), 'Test Lobby');
    connections.remove(foe);
    handler.begin('m1');

    expect(foe.sent).toEqual([]);
    expect(host.sent.length).toBeGreaterThan(0);
  });
});

describe('reconnecting', () => {
  beforeEach(() => {
    store.store(match(), 'Test Lobby');
  });

  it('offers a rejoin rather than silently resuming, for a socket that dropped', () => {
    handler.detach(mate.accountId);
    mate.clear();

    handler.attach(mate);

    expect(mate.sent).toEqual([{ t: 'match.rejoinable', matchId: 'm1', lobbyName: 'Test Lobby' }]);
    // Still marked away — an offer to rejoin is not a rejoin.
    expect(store.find('m1')?.players.find((p) => p.accountId === 'mate')?.connected).toBe(false);
  });

  it('re-sends the whole picture, including the chat that was missed, on an attach that never dropped', () => {
    handler.handle(host, { t: 'chat.send', scope: 'team', text: 'contact west' });
    mate.clear();

    // A tab replaced by another never sees `detach` — `gateway.ts`'s close handler only fires
    // for the connection a new one has already superseded — so the surviving account's own
    // `connected` never goes false, and its next `attach` (the new tab's) still resumes in full.
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

describe('leaving and rejoining', () => {
  beforeEach(() => {
    store.store(match(), 'Test Lobby');
  });

  it('marks the seat vacated and offers a rejoin, on the socket that is still open', () => {
    host.clear();

    handler.departed('host');

    expect(store.find('m1')?.players.find((p) => p.accountId === 'host')?.connected).toBe(false);
    expect(host.sent).toEqual([{ t: 'match.rejoinable', matchId: 'm1', lobbyName: 'Test Lobby' }]);
  });

  it('says nothing to an account departing a match that is not theirs', () => {
    const stranger = fake('stranger');
    connections.add(stranger);

    handler.departed('stranger');

    expect(stranger.sent).toEqual([]);
  });

  it('resends the whole picture on an explicit rejoin', () => {
    handler.departed('host');
    host.clear();

    handler.rejoin(host);

    expect(host.sent.map((m) => m.t)).toEqual(['match.state', 'match.view']);
    expect(store.find('m1')?.players.find((p) => p.accountId === 'host')?.connected).toBe(true);
  });

  it('does nothing for a rejoin from an account with nothing to rejoin', () => {
    const stranger = fake('stranger');
    connections.add(stranger);

    handler.rejoin(stranger);

    expect(stranger.sent).toEqual([]);
  });

  it('stops routing to a match once the account has abandoned it', () => {
    handler.departed('host');

    handler.abandon('host');

    expect(store.findByAccount('host')).toBeUndefined();
    // The offer is gone with it — a later attach has nothing left to send.
    host.clear();
    handler.attach(host);
    expect(host.sent).toEqual([]);
  });
});

describe('publishing view frames', () => {
  it('skips a player who has left, even though the socket is still open', () => {
    store.store(match(), 'Test Lobby');
    handler.departed('host');
    host.clear();

    handler.publish('m1');

    expect(host.sent).toEqual([]);
    // A teammate who is still actively playing keeps getting frames.
    expect(mate.sent.some((m) => m.t === 'match.view')).toBe(true);
  });
});

describe('the debug acoustic fields', () => {
  beforeEach(() => {
    // A coarse lattice and rock mask, which is the standing bargain for a test that has to run
    // real ticks (`MatchRuntimeOptions`): these assert who is sent what, and none of it depends
    // on how finely the ocean was rasterized.
    store = new MatchStore({ cellSize: 80, collisionCell: 40 });
    handler = new MatchHandler({ store, connections, clock: () => now });
  });

  /** The same match, started the way a host who ticked the debug box in the lobby starts it. */
  function debugMatch(): MatchState {
    return deployMatch({
      matchId: 'm1',
      mode: 'objective-capture',
      map: generateMap('empty', { seed: 5, mapSize: 'small' }),
      startedAt: 1_000,
      debugMode: true,
      players: [seat('host', 'team1'), seat('foe', 'team2')],
    });
  }

  /** Advance to the next tick a field is due on, so `publish` has one to send. */
  function runToDue(): void {
    const runtime = store.runtime('m1');
    if (runtime === undefined) throw new Error('no runtime');
    do {
      runtime.tick();
    } while (runtime.state.clock.tick % FIELD_TICKS !== 0);
  }

  const fields = (connection: Fake): ServerMessage[] =>
    connection.sent.filter((message) => message.t === 'debug.field');

  it('refuses the command outright on a match nobody turned debug mode on for', () => {
    store.store(match(), 'Test Lobby');
    handler.handle(host, { t: 'debug.setField', kind: 'noise', boat: null });
    runToDue();
    host.clear();

    handler.publish('m1');

    expect(fields(host)).toEqual([]);
    // And the ordinary frame is unaffected — the refusal is of one feature, not of the player.
    expect(host.sent.some((m) => m.t === 'match.view')).toBe(true);
  });

  it('sends nothing until somebody asks, and then only to them', () => {
    store.store(debugMatch(), 'Test Lobby');
    runToDue();
    for (const connection of [host, foe]) connection.clear();

    handler.publish('m1');
    expect(fields(host)).toEqual([]);

    handler.handle(host, { t: 'debug.setField', kind: 'noise', boat: null });
    // The `noise` overlay is the whole heatmap, and a solve only fills the whole heatmap when
    // somebody has asked for it — so the request has to reach a solve before there is a frame to
    // send (planning/16 §3.9). One publish window, and it is there.
    runToDue();
    for (const connection of [host, foe]) connection.clear();
    handler.publish('m1');

    expect(fields(host)).toHaveLength(1);
    // The overlay is ground truth over the whole map, so who receives it is the whole of the
    // access control: an opponent who did not ask must not be handed one.
    expect(fields(foe)).toEqual([]);

    const [message] = fields(host);
    if (message?.t !== 'debug.field') throw new Error('no field');
    expect(message.tick).toBe(store.find('m1')?.clock.tick);
    expect(message.map.kind).toBe('noise');
    expect(message.map.cols).toBeGreaterThan(0);
    expect(message.map.runs.length).toBeGreaterThan(0);
  });

  it('goes at its own rate rather than with every frame', () => {
    store.store(debugMatch(), 'Test Lobby');
    handler.handle(host, { t: 'debug.setField', kind: 'noise', boat: null });
    runToDue();

    // One tick past a due one is not another one: the payload is orders of magnitude larger than
    // a view frame, and a field on every frame is what this interval exists to prevent.
    store.runtime('m1')?.tick();
    host.clear();
    handler.publish('m1');
    expect(fields(host)).toEqual([]);
    expect(host.sent.some((m) => m.t === 'match.view')).toBe(true);
  });

  it('stops the moment it is switched off', () => {
    store.store(debugMatch(), 'Test Lobby');
    handler.handle(host, { t: 'debug.setField', kind: 'noise', boat: null });
    runToDue();
    host.clear();
    handler.publish('m1');
    expect(fields(host)).toHaveLength(1);

    handler.handle(host, { t: 'debug.setField', kind: null, boat: null });
    host.clear();
    handler.publish('m1');

    expect(fields(host)).toEqual([]);
  });
});

describe('the ping-reach rings', () => {
  beforeEach(() => {
    store = new MatchStore({ cellSize: 80, collisionCell: 40 });
    handler = new MatchHandler({ store, connections, clock: () => now });
  });

  function debugMatch(): MatchState {
    return deployMatch({
      matchId: 'm1',
      mode: 'objective-capture',
      map: generateMap('empty', { seed: 5, mapSize: 'small' }),
      startedAt: 1_000,
      debugMode: true,
      players: [seat('host', 'team1'), seat('foe', 'team2')],
    });
  }

  const reach = (connection: Fake): ServerMessage[] =>
    connection.sent.filter((message) => message.t === 'debug.reach');

  it('refuses the command outright on a match nobody turned debug mode on for', () => {
    store.store(match(), 'Test Lobby');
    handler.handle(host, { t: 'debug.setReach', enabled: true });
    store.runtime('m1')?.tick();
    host.clear();

    handler.publish('m1');

    expect(reach(host)).toEqual([]);
    expect(host.sent.some((m) => m.t === 'match.view')).toBe(true);
  });

  it('sends nothing until somebody asks, and then only to them', () => {
    store.store(debugMatch(), 'Test Lobby');
    store.runtime('m1')?.tick();
    for (const connection of [host, foe]) connection.clear();

    handler.publish('m1');
    expect(reach(host)).toEqual([]);

    handler.handle(host, { t: 'debug.setReach', enabled: true });
    for (const connection of [host, foe]) connection.clear();
    handler.publish('m1');

    expect(reach(host)).toHaveLength(1);
    // The rings are round both fleets at true positions, so who receives one is the whole of the
    // access control — exactly as it is for a field.
    expect(reach(foe)).toEqual([]);

    const [message] = reach(host);
    if (message?.t !== 'debug.reach') throw new Error('no rings');
    expect(message.tick).toBe(store.find('m1')?.clock.tick);
    // Nobody has switched a transducer on, and an empty list is the reading that says so.
    expect(message.rings).toEqual([]);
  });

  it('rides every frame rather than the field’s slower rate', () => {
    store.store(debugMatch(), 'Test Lobby');
    handler.handle(host, { t: 'debug.setReach', enabled: true });

    // Two publishes on two different ticks, neither of them chosen to be a field tick: a ring is
    // read against a hull that is moving, so it goes with the frame that moved it.
    for (let i = 0; i < 2; i += 1) {
      store.runtime('m1')?.tick();
      host.clear();
      handler.publish('m1');
      expect(reach(host)).toHaveLength(1);
    }
  });

  it('stops the moment it is switched off', () => {
    store.store(debugMatch(), 'Test Lobby');
    handler.handle(host, { t: 'debug.setReach', enabled: true });
    store.runtime('m1')?.tick();
    host.clear();
    handler.publish('m1');
    expect(reach(host)).toHaveLength(1);

    handler.handle(host, { t: 'debug.setReach', enabled: false });
    host.clear();
    handler.publish('m1');

    expect(reach(host)).toEqual([]);
  });
});

describe('the debug probe', () => {
  beforeEach(() => {
    store = new MatchStore({ cellSize: 80, collisionCell: 40 });
    handler = new MatchHandler({ store, connections, clock: () => now });
  });

  function debugMatch(): MatchState {
    return deployMatch({
      matchId: 'm1',
      mode: 'objective-capture',
      map: generateMap('empty', { seed: 5, mapSize: 'small' }),
      startedAt: 1_000,
      debugMode: true,
      players: [seat('host', 'team1'), seat('foe', 'team2')],
    });
  }

  const readings = (connection: Fake): ServerMessage[] =>
    connection.sent.filter((message) => message.t === 'debug.reading');

  /** Far enough for a solve to have run: they go at half the tick rate (`ACOUSTIC_TICK_HZ`). */
  function solved(): void {
    const runtime = store.runtime('m1');
    if (runtime === undefined) throw new Error('no runtime');
    runtime.tick();
    runtime.tick();
  }

  /** A point on the water, and the boat the asker commands. */
  function ask(at: Vec2): void {
    const boat = store.find('m1')?.boats.find((candidate) => candidate.team === 'team1');
    handler.handle(host, { t: 'debug.probe', at, boat: boat?.id ?? null });
  }

  it('refuses the command outright on a match nobody turned debug mode on for', () => {
    store.store(match(), 'Test Lobby');
    solved();
    host.clear();

    ask({ x: 500, y: 500 });

    expect(readings(host)).toEqual([]);
  });

  it('answers the asker, immediately, and nobody else', () => {
    // The one command in this section that answers at all — and it answers on the spot rather than
    // waiting for the publishing loop, because somebody is looking at a panel.
    store.store(debugMatch(), 'Test Lobby');
    solved();
    for (const connection of [host, foe]) connection.clear();

    ask({ x: 500, y: 500 });

    expect(readings(host)).toHaveLength(1);
    expect(readings(foe)).toEqual([]);

    const [message] = readings(host);
    if (message?.t !== 'debug.reading') throw new Error('no reading');
    expect(message.tick).toBe(store.find('m1')?.clock.tick);
    expect(message.reading.at).toEqual({ x: 500, y: 500 });
    expect(message.reading.listener?.boat).toBe(
      store.find('m1')?.boats.find((boat) => boat.team === 'team1')?.id,
    );
  });

  it('says nothing at all about a point that is not on the map', () => {
    // The camera cannot present water that is not there, so an out-of-map probe is a client bug or
    // worse — and the panel keeping its last reading is the honest answer to one.
    store.store(debugMatch(), 'Test Lobby');
    solved();
    host.clear();

    ask({ x: -50, y: 500 });
    handler.handle(host, { t: 'debug.probe', at: { x: 'over there' } as never, boat: null });

    expect(readings(host)).toEqual([]);
  });

  it('reads the water out with no boat named at all', () => {
    store.store(debugMatch(), 'Test Lobby');
    solved();
    host.clear();

    handler.handle(host, { t: 'debug.probe', at: { x: 500, y: 500 }, boat: null });

    const [message] = readings(host);
    if (message?.t !== 'debug.reading') throw new Error('no reading');
    expect(message.reading.listener).toBeNull();
    expect(Number.isFinite(message.reading.noise)).toBe(true);
  });
});

describe('the statistics panel', () => {
  beforeEach(() => {
    store = new MatchStore({ cellSize: 80, collisionCell: 40 });
    handler = new MatchHandler({ store, connections, clock: () => now });
  });

  function debugMatch(): MatchState {
    return deployMatch({
      matchId: 'm1',
      mode: 'objective-capture',
      map: generateMap('empty', { seed: 5, mapSize: 'small' }),
      startedAt: 1_000,
      debugMode: true,
      players: [seat('host', 'team1'), seat('foe', 'team2')],
    });
  }

  const stats = (connection: Fake): ServerMessage[] =>
    connection.sent.filter((message) => message.t === 'debug.stats');

  function solved(): void {
    const runtime = store.runtime('m1');
    if (runtime === undefined) throw new Error('no runtime');
    runtime.tick();
    runtime.tick();
  }

  it('refuses the command outright on a match nobody turned debug mode on for', () => {
    // Refused rather than ignored, because this one arms the server's own stopwatch: the cost of
    // measuring is small and it is not zero.
    store.store(match(), 'Test Lobby');
    handler.handle(host, { t: 'debug.setStats', enabled: true });
    solved();
    host.clear();

    handler.publish('m1');

    expect(stats(host)).toEqual([]);
    expect(store.runtime('m1')?.anyDebugStats).toBe(false);
  });

  it('sends nothing until somebody asks, and then only to them', () => {
    store.store(debugMatch(), 'Test Lobby');
    solved();
    for (const connection of [host, foe]) connection.clear();

    handler.publish('m1');
    expect(stats(host)).toEqual([]);

    handler.handle(host, { t: 'debug.setStats', enabled: true });
    solved();
    for (const connection of [host, foe]) connection.clear();
    handler.publish('m1');

    expect(stats(host)).toHaveLength(1);
    expect(stats(foe)).toEqual([]);

    const [message] = stats(host);
    if (message?.t !== 'debug.stats') throw new Error('no stats');
    expect(message.stats.window).toBeGreaterThan(0);
    expect(message.stats.counts.boats).toBe(store.find('m1')?.boats.length);
  });

  it('times its own publish, which is the one phase outside a tick', () => {
    store.store(debugMatch(), 'Test Lobby');
    handler.handle(host, { t: 'debug.setStats', enabled: true });
    solved();
    handler.publish('m1');
    host.clear();
    solved();
    handler.publish('m1');

    const [message] = stats(host);
    if (message?.t !== 'debug.stats') throw new Error('no stats');
    const publish = message.stats.phases.find((phase) => phase.phase === 'publish');
    expect(publish?.runs ?? 0).toBeGreaterThan(0);
  });

  it('stops the moment it is switched off', () => {
    store.store(debugMatch(), 'Test Lobby');
    handler.handle(host, { t: 'debug.setStats', enabled: true });
    solved();
    host.clear();
    handler.publish('m1');
    expect(stats(host)).toHaveLength(1);

    handler.handle(host, { t: 'debug.setStats', enabled: false });
    host.clear();
    handler.publish('m1');

    expect(stats(host)).toEqual([]);
    // And the stopwatch goes back to sleep with it.
    expect(store.runtime('m1')?.anyDebugStats).toBe(false);
  });
});

describe('chat', () => {
  beforeEach(() => {
    store.store(match(), 'Test Lobby');
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

describe('navigation', () => {
  beforeEach(() => {
    store.store(match(), 'Test Lobby');
  });

  function state(): MatchState {
    return store.find('m1')!;
  }

  function hostBoat() {
    const boat = state().boats.find((candidate) => candidate.owner === 'host');
    if (boat === undefined) throw new Error('host has no boat');
    return boat;
  }

  function inside(): { x: number; y: number } {
    const { extents } = state().map;
    return { x: Math.round(extents.width / 2), y: Math.round(extents.height / 2) };
  }

  it('orders a commanded boat to a point inside the map', () => {
    const boat = hostBoat();
    const to = inside();

    handler.handle(host, { t: 'nav.order', boat: boat.id, to, queue: false });

    expect(hostBoat().order).toEqual({ kind: 'transit', waypoints: [to] });
  });

  it('appends a leg when the order is queued', () => {
    const boat = hostBoat();
    const first = inside();
    const second = { ...first, x: first.x - 100 };

    handler.handle(host, { t: 'nav.order', boat: boat.id, to: first, queue: false });
    handler.handle(host, { t: 'nav.order', boat: boat.id, to: second, queue: true });

    expect(hostBoat().order).toEqual({ kind: 'transit', waypoints: [first, second] });
  });

  it('drops an order aimed outside the map', () => {
    const boat = hostBoat();

    handler.handle(host, { t: 'nav.order', boat: boat.id, to: { x: -1, y: 0 }, queue: false });

    expect(hostBoat().order).toEqual({ kind: 'hold' });
  });

  it('refuses to order a boat the sender does not command', () => {
    const boat = hostBoat();
    const to = inside();

    handler.handle(foe, { t: 'nav.order', boat: boat.id, to, queue: false });
    handler.handle(mate, { t: 'nav.cancel', boat: boat.id });

    expect(hostBoat().order).toEqual({ kind: 'hold' });
  });

  it('refuses to order a destroyed boat', () => {
    const boat = hostBoat();
    store.update({
      ...state(),
      boats: state().boats.map((b) =>
        b.id === boat.id ? { ...b, status: 'destroyed' as const } : b,
      ),
    });

    handler.handle(host, { t: 'nav.order', boat: boat.id, to: inside(), queue: false });

    expect(hostBoat().order).toEqual({ kind: 'hold' });
  });

  it('cancels a boat’s orders', () => {
    const boat = hostBoat();
    handler.handle(host, { t: 'nav.order', boat: boat.id, to: inside(), queue: false });
    expect(hostBoat().order.kind).toBe('transit');

    handler.handle(host, { t: 'nav.cancel', boat: boat.id });

    expect(hostBoat().order).toEqual({ kind: 'hold' });
  });

  it('sets the throttle notch, and ignores one that is not a notch', () => {
    const boat = hostBoat();

    handler.handle(host, { t: 'nav.throttle', boat: boat.id, notch: 'flank' });
    expect(hostBoat().throttle).toBe('flank');

    handler.handle(host, { t: 'nav.throttle', boat: boat.id, notch: 'warp' });
    expect(hostBoat().throttle).toBe('flank');
  });

  it('ignores a command from someone who is not in a match', () => {
    const stranger = fake('stranger');
    connections.add(stranger);

    handler.handle(stranger, { t: 'nav.order', boat: 1, to: inside(), queue: false });

    expect(hostBoat().order).toEqual({ kind: 'hold' });
  });
});

// ── commands ────────────────────────────────────────────────────────────────────────

/*
 * The commands are as much about their *shape* as about what they do: nothing is sent back, a
 * boat you do not command is not yours to switch, and a malformed field is dropped rather than
 * trusted. A new command has to pass this same set.
 */
describe('setting active sonar', () => {
  function boatOf(account: string): number {
    const state = store.find('m1');
    return state?.boats.find((boat) => boat.owner === account)?.id ?? -1;
  }

  beforeEach(() => {
    store.store(match(), 'Test Lobby');
    handler.begin('m1');
    for (const connection of [host, mate, foe, watcher]) connection.clear();
  });

  it('switches a boat the sender commands', () => {
    handler.handle(host, { t: 'match.setActiveSonar', boat: boatOf('host'), active: true });

    const boat = store.find('m1')?.boats.find((candidate) => candidate.owner === 'host');
    expect(boat?.activeSonar).toBe(true);
  });

  /*
   * Nothing goes back on the wire — not an acknowledgement and not a rejection. The player is
   * already receiving a view frame ten times a second that carries `activeSonar`, so the switch
   * moving *is* the answer, and a refused command is one where it does not move.
   */
  it('answers with silence, and lets the view frame carry the news', () => {
    handler.handle(host, { t: 'match.setActiveSonar', boat: boatOf('host'), active: true });

    expect(host.sent).toEqual([]);
  });

  it('refuses a teammate’s boat, and an enemy’s', () => {
    handler.handle(host, { t: 'match.setActiveSonar', boat: boatOf('mate'), active: true });
    handler.handle(host, { t: 'match.setActiveSonar', boat: boatOf('foe'), active: true });

    const boats = store.find('m1')?.boats ?? [];
    expect(boats.every((boat) => !boat.activeSonar)).toBe(true);
  });

  it('refuses a spectator, who commands nothing', () => {
    handler.handle(watcher, { t: 'match.setActiveSonar', boat: boatOf('host'), active: true });

    expect(store.find('m1')?.boats.every((boat) => !boat.activeSonar)).toBe(true);
  });

  /*
   * The codec checks the type tag and nothing else, so this is the first message whose *fields*
   * a client chooses and the handler is the only thing standing between them and the world.
   */
  it('drops a command whose fields are the wrong shape', () => {
    const bad = [
      { boat: 'first', active: true },
      { boat: 1.5, active: true },
      { boat: boatOf('host'), active: 'yes' },
      { boat: boatOf('host'), active: undefined },
    ];
    for (const fields of bad) {
      handler.handle(host, { t: 'match.setActiveSonar', ...fields } as never);
    }

    expect(store.find('m1')?.boats.every((boat) => !boat.activeSonar)).toBe(true);
    expect(host.sent).toEqual([]);
  });

  it('ignores a command from someone who is not in a match', () => {
    const stranger = fake('stranger');
    connections.add(stranger);

    handler.handle(stranger, { t: 'match.setActiveSonar', boat: boatOf('host'), active: true });

    expect(store.find('m1')?.boats.every((boat) => !boat.activeSonar)).toBe(true);
  });
});
