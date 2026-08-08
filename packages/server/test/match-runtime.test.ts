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
  THROTTLE_FRACTIONS,
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

/** Put the whole fleet on a throttle notch — the movement phase's job, done by hand until it exists. */
function underWay(state: MatchState, notch: ThrottleNotch): MatchState {
  return {
    ...state,
    boats: state.boats.map((boat) => ({
      ...boat,
      throttle: notch,
      speed: THROTTLE_FRACTIONS[notch] * boat.stats.maxSpeed,
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
    const runtime = new MatchRuntime(underWay(match(), 'standard'));

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
    const runtime = new MatchRuntime(underWay(match(), 'standard'));
    const frame = advance(runtime, 'host', 'team1');

    for (const packed of [frame.charted, frame.cells]) {
      const cells = unpackCells(packed);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells).toEqual([...cells].sort((a, b) => a - b));
      expect(new Set(cells).size).toBe(cells.length);
    }
  });

  it('stops sending a square as a transient once it is on the chart', () => {
    const runtime = new MatchRuntime(underWay(match(), 'standard'));

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
    const runtime = new MatchRuntime(underWay(match(), 'standard'));
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
        'standard',
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
    const runtime = new MatchRuntime(underWay(match(), 'standard'));
    advance(runtime, 'host', 'team1');

    expect(runtime.visionFor('watcher', null)).toBeUndefined();
    expect(
      viewFor(runtime.state, 'watcher', runtime.visionFor('watcher', null)).vision.cells,
    ).toEqual([]);
  });

  it('re-sends the whole chart to a connection that has been forgotten', () => {
    const runtime = new MatchRuntime(underWay(match(), 'standard'));

    const first = advance(runtime, 'host', 'team1');
    expect(first.chartSeen).toBeGreaterThan(0);

    runtime.forget('host');
    const again = advance(runtime, 'host', 'team1');
    expect(again.chartSeen).toBeGreaterThanOrEqual(first.chartSeen);
    expect(unpackCells(again.charted).length).toBeGreaterThanOrEqual(first.charted.length);
  });

  it('keeps one team’s picture out of the other’s', () => {
    const runtime = new MatchRuntime(underWay(match(), 'standard'));
    advance(runtime, 'host', 'team1');
    const theirs = advance(runtime, 'foe', 'team2');
    const mine = runtime.visionFor('host', 'team1');

    // Both sides are listening on the same map, and their charts are different objects with
    // different contents. A shared one would be the whole map handed to whoever heard first.
    expect(unpackCells(theirs.charted)).not.toEqual(unpackCells(mine?.charted ?? []));
  });
});
