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
  ARMING_SECONDS,
  CAPTURE_SECONDS,
  MAX_DEEP_OBJECTIVES,
  deployMatch,
  emittedLevels,
  generateMap,
  isDeepZone,
  SIM_TICK_HZ,
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
    for (let i = 0; i < 85; i += 1) {
      runtime.tick();
      const at = runtime.state.boats.find((boat) => boat.id === id)?.lastPingTick ?? 0;
      if (at !== previous) fired.push(at);
      previous = at;
    }

    // The first is immediate — the switch is already on — and the rest are two seconds apart,
    // which is `ticksPerPing` at 20 Hz.
    expect(fired).toEqual([1, 41, 81]);
  });

  it('cannot be made to pulse faster by flicking the switch', () => {
    const runtime = new MatchRuntime(pinging(match()));
    const id = runtime.state.boats[0]?.id ?? 0;
    const owner = runtime.state.boats.find((boat) => boat.id === id)?.owner ?? '';

    for (let i = 0; i < 10; i += 1) runtime.tick();
    expect(runtime.state.boats.find((boat) => boat.id === id)?.lastPingTick).toBe(1);

    // Off and straight back on, half a second in. The interval is measured from the last
    // pulse rather than from the switch, so the next one is still due at tick 41.
    runtime.setActiveSonar(owner, id, false);
    runtime.setActiveSonar(owner, id, true);
    for (let i = 0; i < 5; i += 1) runtime.tick();
    expect(runtime.state.boats.find((boat) => boat.id === id)?.lastPingTick).toBe(1);

    for (let i = 0; i < 26; i += 1) runtime.tick();
    expect(runtime.state.boats.find((boat) => boat.id === id)?.lastPingTick).toBe(41);
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

// ── collision ───────────────────────────────────────────────────────────────────────

/*
 * The phase itself is pinned in `@seg/shared`'s `collision-phase` suite, which hands it a fleet
 * before and after and asserts on the rule. These are the tests one level up: that the runtime
 * actually *calls* it, in the right order, on real movement — a boat given a real order, running at
 * a real throttle, into something it should not be able to occupy.
 */
describe('collision', () => {
  const MEDIUM: BoatTemplate = { name: 'M-01', hull: 'medium', modules: [] };

  /** Two Mediums nose to nose, `gap` metres apart, with the target's hull optionally already spent. */
  function pair(gap: number, targetHp?: number): MatchState {
    const state = deployMatch({
      matchId: 'm1',
      mode: 'deathmatch',
      map: generateMap('empty', { seed: 11, mapSize: 'small' }),
      startedAt: 0,
      players: [player('host', 'team1', [MEDIUM]), player('foe', 'team2', [MEDIUM])],
    });
    const mine = state.boats.find((boat) => boat.team === 'team1')!;

    return {
      ...state,
      boats: state.boats.map((boat) =>
        boat.team === 'team2'
          ? {
              ...boat,
              pos: { x: mine.pos.x + gap, y: mine.pos.y },
              facing: 180,
              ...(targetHp === undefined ? {} : { hp: targetHp }),
            }
          : boat,
      ),
    };
  }

  /** Tick until the boat has stopped taking orders, or give up. */
  function runUntilHeld(runtime: MatchRuntime, id: number, limit = 800): void {
    for (let i = 0; i < limit; i += 1) {
      runtime.tick();
      if (runtime.state.boats.find((boat) => boat.id === id)?.order.kind === 'hold') return;
    }
    throw new Error('the boat never stopped');
  }

  /**
   * One Heavy pointed at a wall, 35 m of water in front of its bow.
   *
   * The wall is authored rather than generated, and the boat is placed rather than berthed, because
   * what is being tested is the phase running inside a real tick — not the cave generator's habit of
   * putting rock somewhere useful. Started close so the fixture is a couple of seconds of sim rather
   * than a minute of it.
   */
  function facingAWall(): MatchState {
    const base = generateMap('empty', { seed: 11, mapSize: 'small' });
    const map = {
      ...base,
      terrain: {
        obstacles: [
          {
            vertices: [
              { x: 2000, y: 0 },
              { x: 2400, y: 0 },
              { x: 2400, y: base.extents.height },
              { x: 2000, y: base.extents.height },
            ],
          },
        ],
      },
    };
    const state = deployMatch({
      matchId: 'm1',
      mode: 'deathmatch',
      map,
      startedAt: 0,
      players: [player('host', 'team1', [HEAVY])],
    });

    return {
      ...state,
      // 1880 puts the bow at 1965 — clear of the rock, and 35 m from it.
      boats: state.boats.map((boat) => ({ ...boat, pos: { x: 1880, y: boat.pos.y }, facing: 0 })),
    };
  }

  it('will not let a boat swim into rock, and is loud when it tries', () => {
    const runtime = new MatchRuntime(facingAWall(), { collisionCell: 20 });
    const boat = runtime.state.boats[0]!;

    runtime.setThrottle(boat.id, 'flank');
    runtime.order(boat.id, { x: 2600, y: boat.pos.y }, false);
    runUntilHeld(runtime, boat.id);

    const stopped = runtime.state.boats[0]!;
    // The bow is short of the wall, not inside it: refusal puts the boat back somewhere it already
    // legally was, so no arithmetic here can leave a hull in stone.
    expect(stopped.pos.x + 85).toBeLessThanOrEqual(2000);
    expect(stopped.pos.x).toBeGreaterThan(boat.pos.x);
    expect(stopped.speed).toBe(0);
    // The order is gone with it: a boat that kept the route would grind against the wall for the
    // rest of the match, one +30 dB bang a second.
    expect(stopped.order).toEqual({ kind: 'hold' });
    expect(stopped.transients.map((transient) => transient.kind)).toContain('bottoming');
  });

  it('puts the impact into the water, where the other side can hear it', () => {
    const runtime = new MatchRuntime(facingAWall(), { collisionCell: 20 });
    const boat = runtime.state.boats[0]!;
    runtime.setThrottle(boat.id, 'flank');
    runtime.order(boat.id, { x: 2600, y: boat.pos.y }, false);
    runUntilHeld(runtime, boat.id);

    const hit = runtime.state.boats[0]!;
    const banged = emittedLevels(hit, runtime.state.clock.tick, SIM_TICK_HZ);

    // The same door a ping goes through, and that is the whole point: nothing between here and the
    // solver knows a collision from a pulse (`emittedLevels`).
    expect(banged.length).toBeGreaterThan(0);
    expect(Math.max(...banged)).toBeGreaterThan(hit.stats.sourceLevel);
  });

  it('stops a boat ordered into another one, and damages both', () => {
    const runtime = new MatchRuntime(pair(300), { collisionCell: 20 });
    const mine = runtime.state.boats.find((boat) => boat.team === 'team1')!;
    const theirs = runtime.state.boats.find((boat) => boat.team === 'team2')!;

    runtime.setThrottle(mine.id, 'flank');
    runtime.order(mine.id, theirs.pos, false);
    runUntilHeld(runtime, mine.id);

    const after = runtime.state.boats;
    const rammer = after.find((boat) => boat.id === mine.id)!;
    const rammed = after.find((boat) => boat.id === theirs.id)!;

    expect(rammer.hp).toBeLessThan(mine.stats.maxHp);
    // Symmetric: the boat that was sitting still takes the same damage as the one that drove into
    // it, because a collision is not an attack that one side performs on the other.
    expect(rammed.hp).toBeCloseTo(rammer.hp);
    expect(rammer.speed).toBe(0);
    expect(rammer.transients.map((transient) => transient.kind)).toContain('collision');
    expect(rammed.transients.map((transient) => transient.kind)).toContain('collision');
    // And the two hulls are not sharing water afterwards.
    expect(rammer.pos.x).toBeLessThan(rammed.pos.x);
  });

  it('recounts the standings when an impact finishes a boat off', () => {
    const runtime = new MatchRuntime(pair(300, 3), { collisionCell: 20 });
    const mine = runtime.state.boats.find((boat) => boat.team === 'team1')!;
    const theirs = runtime.state.boats.find((boat) => boat.team === 'team2')!;

    expect(runtime.state.teams.team2.boatsAlive).toBe(1);

    runtime.setThrottle(mine.id, 'flank');
    runtime.order(mine.id, theirs.pos, false);
    runUntilHeld(runtime, mine.id);

    const wreck = runtime.state.boats.find((boat) => boat.id === theirs.id)!;
    expect(wreck.hp).toBe(0);
    expect(wreck.status).toBe('destroyed');
    // The standings are derived from the fleet, and a collision is the first thing in the game that
    // can change what they derive from. A scoreboard still counting a wreck as alive is the classic
    // version of this bug, and it stays invisible until a match ends on the wrong number.
    expect(runtime.state.teams.team2.boatsAlive).toBe(0);
    expect(runtime.state.teams.team2.survivingPoints).toBe(0);
    expect(runtime.state.teams.team1.boatsAlive).toBe(1);
  });
});

// ── objectives ──────────────────────────────────────────────────────────────────────

/*
 * The capture rules themselves are pinned in `@seg/shared`'s `match-objectives` suite, which
 * hands `advanceZones` a fleet and a stopwatch. These are the tests one level up: that the
 * runtime *runs* them on real ticks, and that the three things a capture sets off — the point,
 * the replacement, and the minute of grey — all actually happen.
 */
describe('objectives', () => {
  const LIGHT_BOAT: BoatTemplate = { name: 'S-01', hull: 'light', modules: [] };

  /** An objective-capture match with one boat a side, both parked on the first zone. */
  function contest(both: boolean): MatchState {
    const state = deployMatch({
      matchId: 'm1',
      mode: 'objective-capture',
      map: generateMap('empty', { seed: 11, mapSize: 'small' }),
      startedAt: 0,
      players: [player('host', 'team1', [LIGHT_BOAT]), player('foe', 'team2', [LIGHT_BOAT])],
    });
    const target = state.zones[0]!.centre;

    return {
      ...state,
      // Placed rather than driven there: what is being tested is the capture phase inside a
      // real tick, not the ten minutes of transit a fleet would spend reaching the middle.
      boats: state.boats.map((boat) =>
        boat.team === 'team1' || both ? { ...boat, pos: { ...target } } : boat,
      ),
    };
  }

  /** One second of simulation. */
  const SECOND = SIM_TICK_HZ;

  it('scores a point, retires the zone, and opens a replacement elsewhere', () => {
    const runtime = new MatchRuntime(contest(false));
    const taken = runtime.state.zones[0]!;

    for (let i = 0; i < CAPTURE_SECONDS * SECOND; i += 1) runtime.tick();

    expect(runtime.state.teams.team1.score).toBe(1);
    expect(runtime.state.teams.team2.score).toBe(0);
    // The rest of the standing is still derived from the fleet rather than clobbered by the
    // carried score — the whole reason `standingFor` takes the two figures it cannot rebuild.
    expect(runtime.state.teams.team1.boatsAlive).toBe(1);
    expect(runtime.state.teams.team1.survivingPoints).toBeGreaterThan(0);

    const replacement = runtime.state.zones[0]!;
    expect(runtime.state.zones).toHaveLength(3);
    // A new objective in a new place, wearing the slot's name.
    expect(replacement.id).not.toBe(taken.id);
    expect(replacement.label).toBe(taken.label);
    expect(replacement.centre).not.toEqual(taken.centre);
    expect(replacement.progress).toBe(0);
    expect(replacement.capturing).toBeNull();
    // And grey for a minute, so the team standing where the old one was cannot simply take it.
    expect(replacement.armingTicks).toBe(ARMING_SECONDS * SECOND);
  });

  it('does not pay twice for one capture', () => {
    // `advanceZones` leaves a finished zone standing at full progress and would report it again
    // on the next tick; the runtime has to swap it out on the tick it falls. If it ever stops
    // doing that, this is a match that ends 400–0 in half a minute.
    const runtime = new MatchRuntime(contest(false));

    for (let i = 0; i < CAPTURE_SECONDS * SECOND * 2; i += 1) runtime.tick();

    expect(runtime.state.teams.team1.score).toBe(1);
  });

  it('pays nobody while both sides are inside', () => {
    const runtime = new MatchRuntime(contest(true));

    for (let i = 0; i < CAPTURE_SECONDS * SECOND * 2; i += 1) runtime.tick();

    expect(runtime.state.teams.team1.score).toBe(0);
    expect(runtime.state.teams.team2.score).toBe(0);
    expect(runtime.state.zones[0]!.contested).toBe(true);
  });

  it('runs a slot short rather than putting an objective somewhere illegal', () => {
    // A board with no room for a third: two zones are handed in already, and the map is shrunk
    // to a band that cannot hold another one clear of them. The capture still pays its point and
    // still retires the zone — what does not happen is a replacement squeezed in anyway.
    const state = contest(false);
    const [first, second] = state.zones;
    if (first === undefined || second === undefined) throw new Error('fixture needs two zones');

    const runtime = new MatchRuntime({
      ...state,
      // One objective, sitting under team 1's boat. Slots 2 and 3 are vacant from the start.
      zones: [first],
    });

    for (let i = 0; i < CAPTURE_SECONDS * SECOND; i += 1) runtime.tick();

    expect(runtime.state.teams.team1.score).toBe(1);
    // The captured one is gone, and the board refilled every slot it legally could — on open
    // water that is all of them, which is the point: the runtime tries, it does not give up.
    expect(runtime.state.zones.length).toBeGreaterThan(0);
    expect(runtime.state.zones.some((zone) => zone.id === first.id)).toBe(false);
    // Whatever it managed, the slots are still named in order and never doubled up.
    const labels = runtime.state.zones.map((zone) => zone.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual([...labels].sort());
  });

  it('spends no zone id on a slot it could not fill', () => {
    // Ids count up and are never reused. A refused draw must not burn one, or a match on a
    // cramped map would walk the id space for the whole thirty minutes without placing anything.
    const runtime = new MatchRuntime(contest(false));
    const before = Math.max(...runtime.state.zones.map((zone) => zone.id));

    for (let i = 0; i < CAPTURE_SECONDS * SECOND; i += 1) runtime.tick();

    const after = Math.max(...runtime.state.zones.map((zone) => zone.id));
    // Exactly one capture, exactly one replacement, exactly one id.
    expect(after).toBe(before + 1);
  });

  /**
   * Take the first objective on the board `times` over, chasing each replacement.
   *
   * Chasing is the point: a replacement appears somewhere *else*, so a fleet that sat still
   * after one capture would never get another — which is the arming rule working. Teleporting
   * rather than ordering, because what is under test is the spawner across a run of captures
   * and not the ten minutes of transit a fleet would really spend.
   */
  function captureRepeatedly(runtime: MatchRuntime, times: number): void {
    for (let round = 0; round < times; round += 1) {
      const target = runtime.state.zones[0];
      if (target === undefined) return;

      runtime.replace({
        ...runtime.state,
        boats: runtime.state.boats.map((boat) =>
          boat.team === 'team1' ? { ...boat, pos: { ...target.centre } } : boat,
        ),
      });

      // Its grey minute, then its thirty seconds, and a little slack for the tick it falls on.
      const limit = (ARMING_SECONDS + CAPTURE_SECONDS + 2) * SECOND;
      for (let i = 0; i < limit; i += 1) {
        runtime.tick();
        if (!runtime.state.zones.some((zone) => zone.id === target.id)) break;
      }
    }
  }

  it('keeps at most one objective in the deep water across a run of captures', () => {
    // A coarse lattice: this is about where the spawner puts things over many draws, and the
    // acoustic solve is the only expensive part of a tick.
    const runtime = new MatchRuntime(contest(false), { cellSize: 100, collisionCell: 40 });

    captureRepeatedly(runtime, 3);

    // Several fresh positions drawn, and the quota held through all of them — which is really a
    // test that `fillVacancies` measures each draw against the board as it stands, including the
    // zones it placed a moment earlier in the same pass.
    expect(runtime.state.teams.team1.score).toBe(3);
    const deep = runtime.state.zones.filter((zone) =>
      isDeepZone(runtime.state.map.extents, zone.centre),
    );
    expect(deep.length).toBeLessThanOrEqual(MAX_DEEP_OBJECTIVES);
  });

  it('leaves a deathmatch with no objectives to run', () => {
    const runtime = new MatchRuntime(match('empty'));

    for (let i = 0; i < 40; i += 1) runtime.tick();

    expect(runtime.state.zones).toEqual([]);
    expect(runtime.state.teams.team1.score).toBe(0);
  });

  it('puts the whole zone on the wire, position included', () => {
    // A client cannot draw a circle it is only told the status of, and the position is the half
    // that used to ride in `match.state` — where it would have gone stale on the first capture.
    const runtime = new MatchRuntime(contest(false));
    runtime.tick();

    const zones = viewFor(runtime.state, 'host').zones;
    expect(zones).toHaveLength(3);
    for (const zone of zones) {
      expect(zone.radius).toBeGreaterThan(0);
      expect(Number.isFinite(zone.centre.x)).toBe(true);
      expect(zone.label).toMatch(/^OBJ /);
    }
  });
});
