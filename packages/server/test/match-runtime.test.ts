/**
 * The runtime, and the fog of war it builds.
 *
 * These are the acoustics tests' counterpart one level up: `acoustics-vision` proves the solver
 * lights the right squares, and this proves the right squares reach the right team — that a
 * chart grows, that it grows *once*, that a hostile boat becomes a contact only when the server
 * says so, and that a contact which slips detection stops being a reading without disappearing.
 *
 * **The fixtures are under way, deliberately.** A boat at all stop is close to silent, and a
 * silent boat lights nothing around it: "going quiet makes you blind as well as hidden"
 * (planning/03 §5) is the model, not a bug in it. Deployment berths boats stopped, so a fixture
 * that left them there would be asserting on a black screen. A dense map for the same reason —
 * on a sparse one the deployment band is a wide chamber and the nearest wall is out of imaging
 * range.
 */

import {
  ACOUSTICS,
  deployMatch,
  generateMap,
  throttleSpeedFor,
  unpackCells,
  viewFor,
  type BoatTemplate,
  type DeployingPlayer,
  type MatchState,
  type ThrottleNotch,
  type VisionFrame,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

import { MatchRuntime } from '../src/match/runtime.js';

const LIGHT: BoatTemplate = { name: 'S-01', hull: 'light', modules: [] };
const HEAVY: BoatTemplate = { name: 'E-01', hull: 'heavy', modules: [] };

function player(
  accountId: string,
  position: DeployingPlayer['position'],
  boats: readonly BoatTemplate[] = [],
): DeployingPlayer {
  return { accountId, username: accountId, position, boats };
}

/**
 * Put the whole fleet on a throttle notch, loud enough to light up the map. The runtime does
 * this via `order`, but these fixtures bypass movement — the point is the picture, not the ride —
 * so the boats hold their berths while the throttle does the talking.
 */
function underWay(state: MatchState, notch: ThrottleNotch): MatchState {
  return {
    ...state,
    boats: state.boats.map((boat) => ({
      ...boat,
      throttle: notch,
      speed: throttleSpeedFor(boat.stats, notch),
    })),
  };
}

function match(mapType: 'empty' | 'dense' = 'dense'): MatchState {
  return deployMatch({
    matchId: 'm1',
    mode: 'deathmatch',
    map: generateMap(mapType, { seed: 11, mapSize: 'small' }),
    startedAt: 0,
    players: [
      player('host', 'team1', [HEAVY]),
      player('foe', 'team2', [LIGHT]),
      player('watcher', 'spectator'),
    ],
  });
}

/** Tick until a solve comes due, and hand back the frame it produced for `account`. */
function advance(runtime: MatchRuntime, account: string, team: 'team1' | 'team2'): VisionFrame {
  for (let i = 0; i < 64; i += 1) {
    if (!runtime.tick()) continue;
    const frame = runtime.visionFor(account, team);
    if (frame !== undefined) return frame;
  }
  throw new Error('no solve came due');
}

describe('MatchRuntime', () => {
  it('advances the clock at the simulation rate and solves every second tick', () => {
    const runtime = new MatchRuntime(match('empty'));

    expect(runtime.tick()).toBe(false);
    expect(runtime.tick()).toBe(true);
    expect(runtime.state.clock.tick).toBe(2);
    // 20 Hz: two ticks is a tenth of a second, which is also one acoustic period.
    expect(runtime.state.clock.elapsedSeconds).toBeCloseTo(0.1);
    expect(runtime.stats).not.toBeNull();
  });

  it('charts terrain the team has confirmed, and charts each square only once', () => {
    const runtime = new MatchRuntime(underWay(match(), 'flank'));

    const first = advance(runtime, 'host', 'team1');
    expect(first.charted.length).toBeGreaterThan(0);
    expect(first.chartSeen).toBe(first.charted.length);

    // The second frame is the steady state: the walls around a boat that has not moved were
    // confirmed on the first solve and are not news any more. If this ever fails, the chart is
    // being re-sent rather than appended and the bandwidth budget is gone.
    const second = advance(runtime, 'host', 'team1');
    expect(second.charted.length).toBe(0);
    expect(second.chartSeen).toBe(first.chartSeen);
  });

  it('sends squares in ascending order and without repeats, so the deltas stay small', () => {
    const runtime = new MatchRuntime(underWay(match(), 'flank'));
    const frame = advance(runtime, 'host', 'team1');

    for (const packed of [frame.charted, frame.cells]) {
      const cells = unpackCells(packed);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells).toEqual([...cells].sort((a, b) => a - b));
      expect(new Set(cells).size).toBe(cells.length);
    }
  });

  it('stops sending a square as a transient once it is on the chart', () => {
    const runtime = new MatchRuntime(underWay(match(), 'flank'));

    const first = advance(runtime, 'host', 'team1');
    const charted = new Set(unpackCells(first.charted));
    expect(charted.size).toBeGreaterThan(0);

    // A square that confirms is still sent as a transient on the frame it confirms — that is
    // what makes it flash green and settle onto the wall arriving underneath it — so the claim
    // is about the frame *after*.
    const second = advance(runtime, 'host', 'team1');
    for (const cell of unpackCells(second.cells)) expect(charted.has(cell)).toBe(false);
  });

  it('keeps a faint square off the chart while still showing it', () => {
    const runtime = new MatchRuntime(underWay(match(), 'flank'));
    const frame = advance(runtime, 'host', 'team1');

    // The band between the two thresholds is the whole point (planning/03 §5.3): squares the
    // player can see and the server has not committed to.
    const faint = frame.strength.filter((steps) => steps / 2 < ACOUSTICS.confirmationThreshold);
    expect(faint.length).toBeGreaterThan(0);
  });

  it('never lets a team confirm its own boats as contacts', () => {
    // Two boats on one side, close together: each lights the other's hull exactly as the solver
    // would light an enemy's, because it has no idea whose hull it is looking at.
    const state = deployMatch({
      matchId: 'm2',
      mode: 'deathmatch',
      map: generateMap('empty', { seed: 5, mapSize: 'small' }),
      startedAt: 0,
      players: [player('host', 'team1', [LIGHT, HEAVY])],
    });
    const runtime = new MatchRuntime(underWay(state, 'flank'));

    expect(advance(runtime, 'host', 'team1').contacts).toEqual([]);
  });

  it('keeps a contact once confirmed, and lets it go hollow when it slips', () => {
    const state = match('empty');
    // Nose to nose in open water, so the confirmation is guaranteed rather than being at the
    // mercy of where the generator happened to put a wall.
    const runtime = new MatchRuntime(
      underWay(
        {
          ...state,
          boats: state.boats.map((boat, index) => ({
            ...boat,
            pos: { x: 1_000 + index * 60, y: 1_500 },
          })),
        },
        'flank',
      ),
    );

    const seen = advance(runtime, 'host', 'team1');
    const contact = seen.contacts[0];
    expect(contact).toBeDefined();
    expect(contact?.live).toBe(true);
    expect(contact?.hull).toBe('light');

    // Take the other side out of the water entirely and run past the fade window. What is left
    // must be a marker at the pose that was measured — not moved, not deleted, not live.
    runtime.replace({
      ...runtime.state,
      boats: runtime.state.boats.filter((boat) => boat.team === 'team1'),
    });

    let latest = seen;
    for (let i = 0; i < Math.ceil(ACOUSTICS.contactFadeSeconds * 20) + 4; i += 1) {
      if (runtime.tick()) latest = runtime.visionFor('host', 'team1') ?? latest;
    }

    const stale = latest.contacts.find((entry) => entry.id === contact?.id);
    expect(stale).toBeDefined();
    expect(stale?.live).toBe(false);
    expect(stale?.pos).toEqual(contact?.pos);
    expect(stale?.seenTick).toBe(contact?.seenTick);
  });

  it('tells a spectator nothing through vision, because they are given the map instead', () => {
    const runtime = new MatchRuntime(underWay(match(), 'flank'));
    advance(runtime, 'host', 'team1');

    expect(runtime.visionFor('watcher', null)).toBeUndefined();
    expect(
      viewFor(runtime.state, 'watcher', runtime.visionFor('watcher', null)).vision.cells,
    ).toEqual([]);
  });

  it('re-sends the whole chart to a connection that has been forgotten', () => {
    const runtime = new MatchRuntime(underWay(match(), 'flank'));

    const first = advance(runtime, 'host', 'team1');
    expect(first.chartSeen).toBeGreaterThan(0);

    runtime.forget('host');
    const again = advance(runtime, 'host', 'team1');
    expect(again.chartSeen).toBeGreaterThanOrEqual(first.chartSeen);
    expect(unpackCells(again.charted).length).toBeGreaterThanOrEqual(first.charted.length);
  });

  it('keeps one team’s picture out of the other’s', () => {
    const runtime = new MatchRuntime(underWay(match(), 'flank'));
    advance(runtime, 'host', 'team1');
    const theirs = advance(runtime, 'foe', 'team2');
    const mine = runtime.visionFor('host', 'team1');

    // Both sides are listening on the same map, and their charts are different objects with
    // different contents. A shared one would be the whole map handed to whoever heard first.
    expect(unpackCells(theirs.charted)).not.toEqual(unpackCells(mine?.charted ?? []));
  });

  it('moves an ordered boat toward its waypoint, accelerating as it goes', () => {
    const runtime = new MatchRuntime(match('empty'));
    const boat = runtime.state.boats[0]!;
    const start = boat.pos;

    runtime.order(boat.id, { x: start.x + 200, y: start.y }, false);

    let moved = runtime.state.boats[0]!;
    expect(moved.order).toEqual({ kind: 'transit', waypoints: [{ x: start.x + 200, y: start.y }] });

    for (let i = 0; i < 60; i += 1) runtime.tick();
    moved = runtime.state.boats[0]!;

    // Facing is +X from the berth and the waypoint is dead ahead, so it is a straight chase:
    // the boat should be at the slow notch's speed after a few seconds of 10 m/s² acceleration.
    expect(moved.speed).toBeCloseTo(throttleSpeedFor(moved.stats, 'slow'));
    expect(moved.pos.x).toBeGreaterThan(start.x + 5);
    expect(moved.pos.y).toBe(start.y);
  });

  it('cancels a boat’s orders and leaves it where it was asked to stop', () => {
    const runtime = new MatchRuntime(match('empty'));
    const boat = runtime.state.boats[0]!;
    runtime.order(boat.id, { x: boat.pos.x + 200, y: boat.pos.y }, false);
    for (let i = 0; i < 60; i += 1) runtime.tick();

    runtime.cancel(boat.id);
    let held = runtime.state.boats[0]!;
    expect(held.order).toEqual({ kind: 'hold' });
    expect(held.speed).toBe(0);

    const berth = held.pos;
    for (let i = 0; i < 40; i += 1) runtime.tick();
    held = runtime.state.boats[0]!;
    expect(held.pos).toEqual(berth);
  });

  it('queues a waypoint behind the first on a second order, and replaces on a lone one', () => {
    const runtime = new MatchRuntime(match('empty'));
    const boat = runtime.state.boats[0]!;
    const a = { x: boat.pos.x + 100, y: boat.pos.y };
    const b = { x: boat.pos.x + 200, y: boat.pos.y + 40 };

    runtime.order(boat.id, a, false);
    runtime.order(boat.id, b, true);
    expect(runtime.state.boats[0]!.order).toEqual({ kind: 'transit', waypoints: [a, b] });

    runtime.order(boat.id, b, false);
    expect(runtime.state.boats[0]!.order).toEqual({ kind: 'transit', waypoints: [b] });
  });
});

// ── active sonar ────────────────────────────────────────────────────────────────────

/*
 * These are the fixtures that are *not* under way, and that is the point of them: a stopped boat
 * is nearly blind (planning/03 §9.1), so a picture that appears while the fleet sits still is a
 * picture the pulse made. If these ever start passing with `activeSonar: false`, the ping has
 * stopped being what produced the returns.
 */
describe('active sonar', () => {
  /** Switch every boat's sonar on, the way a player would boat by boat. */
  function pinging(state: MatchState): MatchState {
    return { ...state, boats: state.boats.map((boat) => ({ ...boat, activeSonar: true })) };
  }

  it('is off on a fleet that has just deployed', () => {
    const state = match();
    expect(state.boats.every((boat) => !boat.activeSonar)).toBe(true);
    expect(state.boats.every((boat) => boat.lastPingTick === 0)).toBe(true);
  });

  it('pulses at once, and on the interval after that', () => {
    const runtime = new MatchRuntime(pinging(match()));
    const id = runtime.state.boats[0]?.id;

    const fired: number[] = [];
    let previous = 0;
    for (let i = 0; i < 45; i += 1) {
      runtime.tick();
      const at = runtime.state.boats.find((boat) => boat.id === id)?.lastPingTick ?? 0;
      if (at !== previous) fired.push(at);
      previous = at;
    }

    // The first is immediate — the switch is already on — and the rest are a second apart,
    // which is `ticksPerPing` at 20 Hz.
    expect(fired).toEqual([1, 21, 41]);
  });

  it('cannot be made to pulse faster by flicking the switch', () => {
    const runtime = new MatchRuntime(pinging(match()));
    const id = runtime.state.boats[0]?.id ?? 0;
    const owner = runtime.state.boats.find((boat) => boat.id === id)?.owner ?? '';

    for (let i = 0; i < 10; i += 1) runtime.tick();
    expect(runtime.state.boats.find((boat) => boat.id === id)?.lastPingTick).toBe(1);

    // Off and straight back on, half a second in. The interval is measured from the last
    // pulse rather than from the switch, so the next one is still due at tick 21.
    runtime.setActiveSonar(owner, id, false);
    runtime.setActiveSonar(owner, id, true);
    for (let i = 0; i < 5; i += 1) runtime.tick();
    expect(runtime.state.boats.find((boat) => boat.id === id)?.lastPingTick).toBe(1);

    for (let i = 0; i < 6; i += 1) runtime.tick();
    expect(runtime.state.boats.find((boat) => boat.id === id)?.lastPingTick).toBe(21);
  });

  it('refuses a boat the account does not command, and a redundant order', () => {
    const runtime = new MatchRuntime(match());
    const mine = runtime.state.boats.find((boat) => boat.owner === 'host');
    const theirs = runtime.state.boats.find((boat) => boat.owner === 'foe');

    expect(runtime.setActiveSonar('host', theirs?.id ?? 0, true)).toBe(false);
    expect(runtime.setActiveSonar('watcher', mine?.id ?? 0, true)).toBe(false);
    expect(runtime.setActiveSonar('host', 9_999, true)).toBe(false);

    expect(runtime.setActiveSonar('host', mine?.id ?? 0, true)).toBe(true);
    // Idempotent, which is what lets the command ride an unreliable channel (protocol/match.ts).
    expect(runtime.setActiveSonar('host', mine?.id ?? 0, true)).toBe(false);
    expect(runtime.state.boats.find((boat) => boat.id === mine?.id)?.activeSonar).toBe(true);
  });

  /*
   * The payoff, and the reason the mechanic exists at all. A stopped boat images almost nothing
   * — 89 to 179 metres depending on the hull, measured in planning/03 §9.1 — because it is its
   * own illumination. A pulse is seventy decibels above that, so for the few tenths of a second
   * it rings, the same boat lights the rock all the way out to the imaging cap.
   */
  it('lights up rock a silent boat could never have seen', () => {
    const passive = new MatchRuntime(match());
    const active = new MatchRuntime(pinging(match()));

    // Two seconds each: enough for two pulses, and for the passive fixture to have had every
    // chance to find the same walls without one.
    let quiet = 0;
    let loud = 0;
    for (let i = 0; i < 40; i += 1) {
      if (passive.tick())
        quiet = Math.max(quiet, passive.visionFor('host', 'team1')?.chartSeen ?? 0);
      if (active.tick()) loud = Math.max(loud, active.visionFor('host', 'team1')?.chartSeen ?? 0);
    }

    expect(loud).toBeGreaterThan(quiet);
  });

  /*
   * Deployment puts the two sides at opposite ends of the map — 6.2 km apart even on a small
   * one, which is past `maxRange` and therefore past *any* sound, pulse included. So this pair
   * is moved to an engagement range by hand, on an empty map so the only thing between them is
   * water. Two kilometres: far past what either boat can hear the other doing at all stop, and
   * well inside what a pulse carries.
   */
  function duel(separation: number): MatchState {
    const state = deployMatch({
      matchId: 'm1',
      mode: 'deathmatch',
      map: generateMap('empty', { seed: 11, mapSize: 'small' }),
      startedAt: 0,
      players: [player('host', 'team1', [HEAVY]), player('foe', 'team2', [LIGHT])],
    });
    const host = state.boats.find((boat) => boat.team === 'team1');
    if (host === undefined) throw new Error('no host boat');

    return {
      ...state,
      boats: state.boats.map((boat) =>
        boat.team === 'team2'
          ? { ...boat, pos: { x: host.pos.x + separation, y: host.pos.y } }
          : boat,
      ),
    };
  }

  it('makes the boat that fired it enormously easy to hear', () => {
    const state = duel(2000);
    const passive = new MatchRuntime(state);
    const active = new MatchRuntime(pinging(state));

    let quiet = 0;
    let loud = 0;
    for (let i = 0; i < 40; i += 1) {
      if (passive.tick())
        quiet = Math.max(quiet, passive.visionFor('foe', 'team2')?.contacts.length ?? 0);
      if (active.tick())
        loud = Math.max(loud, active.visionFor('foe', 'team2')?.contacts.length ?? 0);
    }

    // Stopped and two kilometres off, the Heavy is inaudible. The instant it pings it is a
    // confirmed contact — position, heading, and a silhouette — to a boat that did nothing at
    // all to earn it. That asymmetry is the entire cost of the switch.
    expect(quiet).toBe(0);
    expect(loud).toBeGreaterThan(0);
  });
});
