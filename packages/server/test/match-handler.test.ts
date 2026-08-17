/**
 * The match handler: who is told what, and what a client is allowed to ask for.
 *
 * Unit-level against fake connections, so the fan-out rules are asserted without a socket. The
 * end-to-end path is in gateway.test.ts, and the thread boundary itself is in match-worker.test.ts.
 *
 * ## What changed when matches moved onto threads
 *
 * This file used to reach into `MatchStore.find('m1')` and read the fleet to check that a command
 * had landed. It cannot any more, and that is the point: the main thread does not hold the boats
 * (`match/worker/protocol.ts`). So a command is now checked the way a *player* would check it —
 * by looking at the next view frame, where `boats` carries the order, the throttle and the sonar
 * switch for every boat on your side.
 *
 * That is a better test than the one it replaces. "The state changed" and "the player was told the
 * state changed" were always two claims, and only the second one is the product.
 *
 * The cost is that every assertion is now preceded by an `await`, because a frame is built on
 * another thread. `fixture.ticks(2)` advances to the next solve — a frame is due every second tick
 * (planning/04 §1) — and resolves when the worker has caught up.
 */

import { FIELD_MAP_HZ, SIM_TICK_HZ, type BoatSnapshot, type ServerMessage } from '@seg/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fake, harness, match, seat, type Fake, type MatchFixture } from './match-harness.js';

/** Sim ticks between field payloads, as the worker derives it. */
const FIELD_TICKS = Math.max(1, Math.round(SIM_TICK_HZ / FIELD_MAP_HZ));

let fixture: MatchFixture;
let host: Fake;
let mate: Fake;
let foe: Fake;
let watcher: Fake;

beforeEach(() => {
  fixture = harness();
  [host, mate, foe, watcher] = [fake('host'), fake('mate'), fake('foe'), fake('watcher')];
  for (const connection of [host, mate, foe, watcher]) fixture.connections.add(connection);
});

afterEach(async () => {
  await fixture.close();
});

/** Start the standard four-seat match and announce it. */
async function begin(options: Parameters<typeof match>[0] = {}): Promise<void> {
  await fixture.store.begin(match(options), 'Test Lobby');
  fixture.handler.begin('m1');
  await fixture.sync();
}

/** The two-seat, debug-enabled match the console tests use. */
async function beginDebug(): Promise<void> {
  await fixture.store.begin(
    match({ debugMode: true, players: [seat('host', 'team1'), seat('foe', 'team2')] }),
    'Test Lobby',
  );
  fixture.handler.begin('m1');
  await fixture.sync();
}

/** Advance to the next frame, which is the only way to observe a command having landed. */
async function frame(): Promise<void> {
  await fixture.ticks(2);
}

/** One boat as its owner is shown it — the replacement for reading ground truth. */
function ownBoat(connection: Fake): BoatSnapshot | undefined {
  const view = connection.last('match.view');
  const mine = view?.view.own[0]?.id;
  return view?.view.boats.find((boat) => boat.id === mine);
}

/** A boat id, taken from the frame its own commander was sent. */
function boatOf(connection: Fake): number {
  return connection.last('match.view')?.view.own[0]?.id ?? -1;
}

function clear(...connections: Fake[]): void {
  for (const connection of connections) connection.clear();
}

const only = (connection: Fake, type: ServerMessage['t']): ServerMessage[] =>
  connection.sent.filter((message) => message.t === type);

describe('beginning a match', () => {
  it('sends every player their own setup and a first frame', async () => {
    await begin();

    for (const connection of [host, mate, foe]) {
      expect(connection.types()).toEqual(['match.state', 'match.view']);
    }

    const state = host.last('match.state');
    expect(state?.setup.you.team).toBe('team1');
    expect(state?.setup.fleet.every((boat) => boat.team === 'team1')).toBe(true);

    // And the other side is told about its own, which is a different set of boats.
    const rival = foe.last('match.state');
    expect(rival?.setup.fleet.map((b) => b.id)).not.toEqual(state?.setup.fleet.map((b) => b.id));
  });

  it('sends a spectator the map and the roster, but no fleet', async () => {
    await begin();

    const state = watcher.last('match.state');
    expect(state?.setup.fleet).toEqual([]);
    expect(state?.setup.map.extents.width).toBeGreaterThan(0);
    expect(state?.setup.players).toHaveLength(4);
  });

  it('says nothing to an account with no socket', async () => {
    await fixture.store.begin(match(), 'Test Lobby');
    fixture.connections.remove(foe);
    fixture.handler.begin('m1');
    await fixture.sync();

    expect(foe.sent).toEqual([]);
    expect(host.sent.length).toBeGreaterThan(0);
  });
});

describe('reconnecting', () => {
  beforeEach(async () => {
    await begin();
  });

  it('offers a rejoin rather than silently resuming, for a socket that dropped', async () => {
    fixture.handler.detach(mate.accountId);
    await fixture.sync();
    clear(mate);

    fixture.handler.attach(mate);
    await fixture.sync();

    expect(mate.sent).toEqual([{ t: 'match.rejoinable', matchId: 'm1', lobbyName: 'Test Lobby' }]);
    // Still marked away — an offer to rejoin is not a rejoin.
    expect(fixture.store.digest('m1')?.players.find((p) => p.accountId === 'mate')?.connected).toBe(
      false,
    );
  });

  it('re-sends the whole picture, including the chat that was missed, on an attach that never dropped', async () => {
    fixture.handler.handle(host, { t: 'chat.send', scope: 'team', text: 'contact west' });
    clear(mate);

    // A tab replaced by another never sees `detach` — `gateway.ts`'s close handler only fires
    // for the connection a new one has already superseded — so the surviving account's own
    // `connected` never goes false, and its next `attach` (the new tab's) still resumes in full.
    fixture.handler.attach(mate);
    await fixture.sync();

    // The chat comes from this thread and the picture from the match's, so the two interleave.
    // Which is why this asserts on the *set* rather than the order — see `MatchHandler.resume`.
    expect(mate.types().sort()).toEqual(['chat.message', 'match.state', 'match.view']);
    expect(mate.lines()).toEqual(['contact west']);
    expect(fixture.store.digest('m1')?.players.find((p) => p.accountId === 'mate')?.connected).toBe(
      true,
    );
  });

  it('holds the seat while a player is away, and keeps their boat in the water', async () => {
    fixture.handler.detach('host');
    await fixture.sync();

    expect(fixture.store.digest('m1')?.players.find((p) => p.accountId === 'host')?.connected).toBe(
      false,
    );

    // The boat is still there, which a teammate's frame is what proves — this thread has no
    // fleet to ask, and a teammate sees the whole of their own side.
    await frame();
    const fleet = mate.last('match.view')?.view.boats ?? [];
    expect(fleet.length).toBe(2);
  });

  it('says nothing to a connection whose account is in no match', async () => {
    const stranger = fake('stranger');
    fixture.handler.attach(stranger);
    await fixture.sync();

    expect(stranger.sent).toEqual([]);
  });
});

describe('leaving and rejoining', () => {
  beforeEach(async () => {
    await begin();
  });

  it('marks the seat vacated and offers a rejoin, on the socket that is still open', async () => {
    clear(host);

    fixture.handler.departed('host');
    await fixture.sync();

    expect(fixture.store.digest('m1')?.players.find((p) => p.accountId === 'host')?.connected).toBe(
      false,
    );
    expect(host.sent).toEqual([{ t: 'match.rejoinable', matchId: 'm1', lobbyName: 'Test Lobby' }]);
  });

  it('says nothing to an account departing a match that is not theirs', async () => {
    const stranger = fake('stranger');
    fixture.connections.add(stranger);

    fixture.handler.departed('stranger');
    await fixture.sync();

    expect(stranger.sent).toEqual([]);
  });

  it('resends the whole picture on an explicit rejoin', async () => {
    fixture.handler.departed('host');
    await fixture.sync();
    clear(host);

    fixture.handler.rejoin(host);
    await fixture.sync();

    expect(host.types().sort()).toEqual(['match.state', 'match.view']);
    expect(fixture.store.digest('m1')?.players.find((p) => p.accountId === 'host')?.connected).toBe(
      true,
    );
  });

  it('does nothing for a rejoin from an account with nothing to rejoin', async () => {
    const stranger = fake('stranger');
    fixture.connections.add(stranger);

    fixture.handler.rejoin(stranger);
    await fixture.sync();

    expect(stranger.sent).toEqual([]);
  });

  it('stops routing to a match once the account has abandoned it', async () => {
    fixture.handler.departed('host');
    fixture.handler.abandon('host');
    await fixture.sync();

    expect(fixture.store.digestByAccount('host')).toBeUndefined();
    // The offer is gone with it — a later attach has nothing left to send.
    clear(host);
    fixture.handler.attach(host);
    await fixture.sync();
    expect(host.sent).toEqual([]);
  });
});

describe('publishing view frames', () => {
  it('skips a player who has left, even though the socket is still open', async () => {
    await begin();
    fixture.handler.departed('host');
    await fixture.sync();
    clear(host, mate);

    await frame();

    expect(only(host, 'match.view')).toEqual([]);
    // A teammate who is still actively playing keeps getting frames.
    expect(only(mate, 'match.view').length).toBeGreaterThan(0);
  });
});

describe('the debug acoustic fields', () => {
  /** Advance to the next tick a field is due on, so a publish has one to send. */
  async function runToDue(): Promise<void> {
    // A field rides a publish, and publishes happen on solve ticks, so this walks in twos to a
    // tick that is both. `FIELD_TICKS` is a multiple of the solve interval by construction.
    for (let i = 0; i < FIELD_TICKS; i += 2) await fixture.ticks(2);
  }

  it('refuses the command outright on a match nobody turned debug mode on for', async () => {
    await begin();
    fixture.handler.handle(host, { t: 'debug.setField', kind: 'noise', boat: null });
    await runToDue();
    clear(host);

    await frame();

    expect(only(host, 'debug.field')).toEqual([]);
    // And the ordinary frame is unaffected — the refusal is of one feature, not of the player.
    expect(only(host, 'match.view').length).toBeGreaterThan(0);
  });

  it('sends nothing until somebody asks, and then only to them', async () => {
    await beginDebug();
    await runToDue();
    clear(host, foe);

    await frame();
    expect(only(host, 'debug.field')).toEqual([]);

    fixture.handler.handle(host, { t: 'debug.setField', kind: 'noise', boat: null });
    // The `noise` overlay is the whole heatmap, and a solve only fills the whole heatmap when
    // somebody has asked for it — so the request has to reach a solve before there is a frame to
    // send (planning/16 §3.9).
    await runToDue();
    clear(host, foe);
    await runToDue();

    expect(only(host, 'debug.field').length).toBeGreaterThan(0);
    // The overlay is ground truth over the whole map, so who receives it is the whole of the
    // access control: an opponent who did not ask must not be handed one.
    expect(only(foe, 'debug.field')).toEqual([]);

    const message = host.last('debug.field');
    expect(message?.map.kind).toBe('noise');
    expect(message?.map.cols).toBeGreaterThan(0);
    expect(message?.map.runs.length).toBeGreaterThan(0);
  });

  it('goes at its own rate rather than with every frame', async () => {
    await beginDebug();
    fixture.handler.handle(host, { t: 'debug.setField', kind: 'noise', boat: null });
    await runToDue();
    await runToDue();

    // A publish that is not on a field tick is not another field: the payload is orders of
    // magnitude larger than a view frame, and a field on every frame is what the interval prevents.
    clear(host);
    await fixture.ticks(2);
    expect(only(host, 'debug.field')).toEqual([]);
    expect(only(host, 'match.view').length).toBeGreaterThan(0);
  });

  it('stops the moment it is switched off', async () => {
    await beginDebug();
    fixture.handler.handle(host, { t: 'debug.setField', kind: 'noise', boat: null });
    await runToDue();
    await runToDue();
    clear(host);
    await runToDue();
    expect(only(host, 'debug.field').length).toBeGreaterThan(0);

    fixture.handler.handle(host, { t: 'debug.setField', kind: null, boat: null });
    clear(host);
    await runToDue();

    expect(only(host, 'debug.field')).toEqual([]);
  });
});

describe('the ping-reach rings', () => {
  it('refuses the command outright on a match nobody turned debug mode on for', async () => {
    await begin();
    fixture.handler.handle(host, { t: 'debug.setReach', enabled: true });
    clear(host);

    await frame();

    expect(only(host, 'debug.reach')).toEqual([]);
    expect(only(host, 'match.view').length).toBeGreaterThan(0);
  });

  it('sends nothing until somebody asks, and then only to them', async () => {
    await beginDebug();
    clear(host, foe);

    await frame();
    expect(only(host, 'debug.reach')).toEqual([]);

    fixture.handler.handle(host, { t: 'debug.setReach', enabled: true });
    clear(host, foe);
    await frame();

    expect(only(host, 'debug.reach')).toHaveLength(1);
    // The rings are round both fleets at true positions, so who receives one is the whole of the
    // access control — exactly as it is for a field.
    expect(only(foe, 'debug.reach')).toEqual([]);

    // Nobody has switched a transducer on, and an empty list is the reading that says so.
    expect(host.last('debug.reach')?.rings).toEqual([]);
  });

  it('rides every frame rather than the field’s slower rate', async () => {
    await beginDebug();
    fixture.handler.handle(host, { t: 'debug.setReach', enabled: true });

    // Two publishes on two different ticks, neither of them a field tick: a ring is read against a
    // hull that is moving, so it goes with the frame that moved it.
    for (let i = 0; i < 2; i += 1) {
      clear(host);
      await frame();
      expect(only(host, 'debug.reach')).toHaveLength(1);
    }
  });

  it('stops the moment it is switched off', async () => {
    await beginDebug();
    fixture.handler.handle(host, { t: 'debug.setReach', enabled: true });
    clear(host);
    await frame();
    expect(only(host, 'debug.reach')).toHaveLength(1);

    fixture.handler.handle(host, { t: 'debug.setReach', enabled: false });
    clear(host);
    await frame();

    expect(only(host, 'debug.reach')).toEqual([]);
  });
});

describe('the debug probe', () => {
  const at = { x: 900, y: 900 };

  it('refuses the command outright on a match nobody turned debug mode on for', async () => {
    await begin();
    await frame();
    clear(host);

    fixture.handler.handle(host, { t: 'debug.probe', boat: null, at });
    await fixture.sync();

    expect(only(host, 'debug.reading')).toEqual([]);
  });

  it('answers the asker, immediately, and nobody else', async () => {
    await beginDebug();
    // Far enough for a solve to have run: they go at half the tick rate (`ACOUSTIC_TICK_HZ`).
    await frame();
    clear(host, foe);

    fixture.handler.handle(host, { t: 'debug.probe', boat: null, at });
    await fixture.sync();

    // The one command in the match protocol that answers, and the only one that waits on a round
    // trip through the thread (`MatchHandler.debugProbe`).
    expect(only(host, 'debug.reading')).toHaveLength(1);
    expect(only(foe, 'debug.reading')).toEqual([]);

    const reading = host.last('debug.reading');
    expect(reading?.reading.at).toEqual(at);
    // Stamped with the tick it was measured on, which is the worker's own clock — the only reason
    // the digest does not carry one (`worker/protocol.ts`).
    expect(reading?.tick).toBeGreaterThan(0);
  });

  it('says nothing at all about a point that is not on the map', async () => {
    await beginDebug();
    await frame();
    clear(host);

    fixture.handler.handle(host, { t: 'debug.probe', boat: null, at: { x: -5, y: 10 } });
    await fixture.sync();

    expect(only(host, 'debug.reading')).toEqual([]);
  });

  it('reads the water out with no boat named at all', async () => {
    await beginDebug();
    await frame();
    clear(host);

    fixture.handler.handle(host, { t: 'debug.probe', boat: null, at });
    await fixture.sync();

    const reading = host.last('debug.reading');
    // The water's own numbers do not need anybody to be listening for them.
    expect(reading?.reading.listener).toBeNull();
    expect(Number.isFinite(reading?.reading.noise ?? NaN)).toBe(true);
  });
});

describe('the statistics panel', () => {
  it('refuses the command outright on a match nobody turned debug mode on for', async () => {
    await begin();
    fixture.handler.handle(host, { t: 'debug.setStats', enabled: true });
    clear(host);

    await frame();

    expect(only(host, 'debug.stats')).toEqual([]);
  });

  it('sends nothing until somebody asks, and then only to them', async () => {
    await beginDebug();
    clear(host, foe);

    await frame();
    expect(only(host, 'debug.stats')).toEqual([]);

    fixture.handler.handle(host, { t: 'debug.setStats', enabled: true });
    // The stopwatch is dormant until somebody is watching, so the first window has to be measured
    // before there is a panel to send (`match/perf.ts`).
    await frame();
    clear(host, foe);
    await frame();

    expect(only(host, 'debug.stats')).toHaveLength(1);
    expect(only(foe, 'debug.stats')).toEqual([]);
  });

  it('times its own publish, which is the one phase outside a tick', async () => {
    await beginDebug();
    fixture.handler.handle(host, { t: 'debug.setStats', enabled: true });
    await frame();
    clear(host);
    await frame();

    const stats = host.last('debug.stats');
    // `publish` is measured on the match's own thread now, around the loop that builds and encodes
    // every recipient's frame (`worker/entry.ts`) — which is *more* of the work than it used to
    // time, since the encode moved in with it. It is still its own phase, and it still ran.
    const publish = stats?.stats.phases.find((phase) => phase.phase === 'publish');
    expect(publish?.runs).toBeGreaterThan(0);
  });

  it('stops the moment it is switched off', async () => {
    await beginDebug();
    fixture.handler.handle(host, { t: 'debug.setStats', enabled: true });
    await frame();
    clear(host);
    await frame();
    expect(only(host, 'debug.stats')).toHaveLength(1);

    fixture.handler.handle(host, { t: 'debug.setStats', enabled: false });
    clear(host);
    await frame();

    expect(only(host, 'debug.stats')).toEqual([]);
  });
});

describe('chat', () => {
  beforeEach(async () => {
    await begin();
    clear(host, mate, foe, watcher);
  });

  it('keeps a team line inside the team, and lets spectators read it', async () => {
    fixture.handler.handle(host, { t: 'chat.send', scope: 'team', text: 'contact west' });

    expect(host.lines()).toEqual(['contact west']);
    expect(mate.lines()).toEqual(['contact west']);
    expect(foe.lines()).toEqual([]);
    expect(watcher.lines()).toEqual(['contact west']);
  });

  it('lets an all line reach everyone', () => {
    fixture.handler.handle(host, { t: 'chat.send', scope: 'all', text: 'good luck' });

    for (const connection of [host, mate, foe, watcher]) {
      expect(connection.lines()).toEqual(['good luck']);
    }
  });

  it('stamps the sender from the connection, never from the message', () => {
    fixture.handler.handle(host, {
      t: 'chat.send',
      scope: 'all',
      text: 'hello',
      from: 'foe',
      username: 'foe',
    } as never);

    const line = host.last('chat.message');
    expect(line?.entry.from).toBe('host');
    expect(line?.entry.username).toBe('host');
    expect(line?.entry.team).toBe('team1');
  });

  it('refuses a channel the speaker is not on', () => {
    fixture.handler.handle(host, { t: 'chat.send', scope: 'spectator', text: 'hi' });

    expect(host.last('chat.rejected')).toBeDefined();
    expect(watcher.lines()).toEqual([]);
  });

  it('gives the observers a channel of their own', () => {
    fixture.handler.handle(watcher, { t: 'chat.send', scope: 'spectator', text: 'nice shot' });

    expect(watcher.lines()).toEqual(['nice shot']);
    expect(host.lines()).toEqual([]);
    expect(foe.lines()).toEqual([]);
  });

  it('normalizes and refuses what is left of an empty or oversized line', () => {
    fixture.handler.handle(host, { t: 'chat.send', scope: 'all', text: '   ' });
    fixture.handler.handle(host, { t: 'chat.send', scope: 'all', text: 'x'.repeat(5_000) });

    expect(host.lines()).toEqual([]);
    expect(only(host, 'chat.rejected')).toHaveLength(2);
  });

  it('collapses a line the client did not normalize', () => {
    fixture.handler.handle(host, { t: 'chat.send', scope: 'all', text: '  hello   there  ' });

    expect(host.lines()).toEqual(['hello there']);
  });

  it('rate limits a burst and lets the window slide', () => {
    for (let i = 0; i < 10; i += 1) {
      fixture.handler.handle(host, { t: 'chat.send', scope: 'all', text: `line ${String(i)}` });
    }

    const delivered = host.lines().length;
    expect(delivered).toBeGreaterThan(0);
    expect(only(host, 'chat.rejected').length).toBeGreaterThan(0);

    // The window is a sliding list of send times, so moving the clock past it opens it again.
    fixture.setNow(10_000 + 60_000);
    fixture.handler.handle(host, { t: 'chat.send', scope: 'all', text: 'later' });
    expect(host.lines()).toContain('later');
  });

  it('limits per account rather than globally', () => {
    for (let i = 0; i < 10; i += 1) {
      fixture.handler.handle(host, { t: 'chat.send', scope: 'all', text: `line ${String(i)}` });
    }
    fixture.handler.handle(foe, { t: 'chat.send', scope: 'all', text: 'mine' });

    expect(foe.lines()).toContain('mine');
  });

  it('ignores a line from someone who is not in a match', () => {
    const stranger = fake('stranger');
    fixture.connections.add(stranger);

    fixture.handler.handle(stranger, { t: 'chat.send', scope: 'all', text: 'anyone there' });

    expect(stranger.sent).toEqual([]);
    expect(host.lines()).toEqual([]);
  });
});

describe('navigation', () => {
  let boat: number;
  let inside: { x: number; y: number };

  beforeEach(async () => {
    await begin();
    await frame();
    boat = boatOf(host);
    const extents = fixture.store.digest('m1')?.extents;
    inside = {
      x: Math.round((extents?.width ?? 0) / 2),
      y: Math.round((extents?.height ?? 0) / 2),
    };
  });

  it('orders a commanded boat to a point inside the map', async () => {
    fixture.handler.handle(host, { t: 'nav.order', boat, to: inside, queue: false });
    await frame();

    expect(ownBoat(host)?.order).toEqual({ kind: 'transit', waypoints: [inside] });
  });

  it('appends a leg when the order is queued', async () => {
    const second = { ...inside, x: inside.x - 100 };

    fixture.handler.handle(host, { t: 'nav.order', boat, to: inside, queue: false });
    fixture.handler.handle(host, { t: 'nav.order', boat, to: second, queue: true });
    await frame();

    expect(ownBoat(host)?.order).toEqual({ kind: 'transit', waypoints: [inside, second] });
  });

  it('drops an order aimed outside the map', async () => {
    // Refused on this thread, before it costs a hop: the map bounds are on the digest, which is
    // most of what the digest is for (`MatchHandler.order`).
    fixture.handler.handle(host, { t: 'nav.order', boat, to: { x: -1, y: 0 }, queue: false });
    await frame();

    expect(ownBoat(host)?.order).toEqual({ kind: 'hold' });
  });

  it('refuses to order a boat the sender does not command', async () => {
    // Refused on the *match's* thread, where the boats are — this one cannot tell whose boat that
    // is any more, and `MatchRuntime.commands` is the rule that stops it.
    fixture.handler.handle(foe, { t: 'nav.order', boat, to: inside, queue: false });
    fixture.handler.handle(mate, { t: 'nav.cancel', boat });
    await frame();

    expect(ownBoat(host)?.order).toEqual({ kind: 'hold' });
  });

  it('cancels a boat’s orders', async () => {
    fixture.handler.handle(host, { t: 'nav.order', boat, to: inside, queue: false });
    await frame();
    expect(ownBoat(host)?.order.kind).toBe('transit');

    fixture.handler.handle(host, { t: 'nav.cancel', boat });
    await frame();

    expect(ownBoat(host)?.order).toEqual({ kind: 'hold' });
  });

  it('sets the throttle notch, and ignores one that is not a notch', async () => {
    fixture.handler.handle(host, { t: 'nav.throttle', boat, notch: 'flank' });
    await frame();
    expect(ownBoat(host)?.throttle).toBe('flank');

    fixture.handler.handle(host, { t: 'nav.throttle', boat, notch: 'warp' } as never);
    await frame();
    expect(ownBoat(host)?.throttle).toBe('flank');
  });

  it('ignores a command from someone who is not in a match', async () => {
    const stranger = fake('stranger');
    fixture.connections.add(stranger);

    fixture.handler.handle(stranger, { t: 'nav.order', boat, to: inside, queue: false });
    await frame();

    expect(ownBoat(host)?.order).toEqual({ kind: 'hold' });
  });
});

// ── commands ────────────────────────────────────────────────────────────────────────

/*
 * The commands are as much about their *shape* as about what they do: nothing is sent back, a
 * boat you do not command is not yours to switch, and a malformed field is dropped rather than
 * trusted. A new command has to pass this same set.
 */
describe('setting active sonar', () => {
  beforeEach(async () => {
    await begin();
    await frame();
  });

  /** Whether any boat on the host's side has its transducer on, as the host is shown it. */
  const anyLit = (connection: Fake): boolean =>
    (connection.last('match.view')?.view.boats ?? []).some((boat) => boat.activeSonar);

  it('switches a boat the sender commands', async () => {
    fixture.handler.handle(host, { t: 'match.setActiveSonar', boat: boatOf(host), active: true });
    await frame();

    expect(ownBoat(host)?.activeSonar).toBe(true);
  });

  /*
   * Nothing goes back on the wire — not an acknowledgement and not a rejection. The player is
   * already receiving a view frame ten times a second that carries `activeSonar`, so the switch
   * moving *is* the answer, and a refused command is one where it does not move.
   */
  it('answers with silence, and lets the view frame carry the news', async () => {
    clear(host);
    fixture.handler.handle(host, { t: 'match.setActiveSonar', boat: boatOf(host), active: true });
    await fixture.sync();

    expect(host.sent).toEqual([]);
  });

  it('refuses a teammate’s boat, and an enemy’s', async () => {
    const theirs = boatOf(mate);
    const enemy = boatOf(foe);

    fixture.handler.handle(host, { t: 'match.setActiveSonar', boat: theirs, active: true });
    fixture.handler.handle(host, { t: 'match.setActiveSonar', boat: enemy, active: true });
    await frame();

    expect(anyLit(host)).toBe(false);
    expect(anyLit(foe)).toBe(false);
  });

  it('refuses a spectator, who commands nothing', async () => {
    fixture.handler.handle(watcher, {
      t: 'match.setActiveSonar',
      boat: boatOf(host),
      active: true,
    });
    await frame();

    expect(anyLit(host)).toBe(false);
  });

  /*
   * The codec checks the type tag and nothing else, so this is the first message whose *fields*
   * a client chooses and the handler is the only thing standing between them and the world.
   */
  it('drops a command whose fields are the wrong shape', async () => {
    const mine = boatOf(host);
    const bad = [
      { boat: 'first', active: true },
      { boat: 1.5, active: true },
      { boat: mine, active: 'yes' },
      { boat: mine, active: undefined },
    ];
    clear(host);
    for (const fields of bad) {
      fixture.handler.handle(host, { t: 'match.setActiveSonar', ...fields } as never);
    }
    await frame();

    expect(anyLit(host)).toBe(false);
    expect(only(host, 'chat.rejected')).toEqual([]);
  });

  it('ignores a command from someone who is not in a match', async () => {
    const stranger = fake('stranger');
    fixture.connections.add(stranger);

    fixture.handler.handle(stranger, {
      t: 'match.setActiveSonar',
      boat: boatOf(host),
      active: true,
    });
    await frame();

    expect(anyLit(host)).toBe(false);
  });
});
