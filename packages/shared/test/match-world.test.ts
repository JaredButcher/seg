/**
 * The match vocabulary: teams, throttle notches, and what a boat is worth.
 *
 * Small functions, but three of them are the kind that are wrong in a way nobody notices for
 * a month — a cavitation threshold read the wrong way round, a damaged boat counted at full
 * value, a spectator given a side.
 */

import {
  DAMAGED_HP_FRACTION,
  describeTeam,
  getHull,
  HULL_IDS,
  isCavitating,
  isDamaged,
  isRinging,
  isTeamId,
  KNOTS_TO_MPS,
  opposingTeam,
  pruneTransients,
  quietestLoudNotch,
  survivingValue,
  teamOf,
  THROTTLE_NOTCHES,
  throttleSpeedFor,
  TRANSIENTS,
  withTransient,
  type BoatState,
  type Stats,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

const STATS: Stats = getHull('medium').stats;

function boat(overrides: Partial<BoatState> = {}): BoatState {
  return {
    id: 1,
    team: 'team1',
    owner: 'a1',
    index: 0,
    name: 'S-01',
    hull: 'medium',
    stats: STATS,
    cost: 120,
    pos: { x: 0, y: 0 },
    facing: 0,
    speed: 0,
    throttle: 'slow',
    hp: STATS.maxHp,
    tubes: [],
    order: { kind: 'hold' },
    status: 'active',
    activeSonar: false,
    lastPingTick: 0,
    transients: [],
    ...overrides,
  };
}

describe('teams', () => {
  it('maps a lobby seat to a side, and a spectator to neither', () => {
    expect(teamOf('team1')).toBe('team1');
    expect(teamOf('team2')).toBe('team2');
    expect(teamOf('spectator')).toBeNull();
  });

  it('knows the other side, and only recognises the two', () => {
    expect(opposingTeam('team1')).toBe('team2');
    expect(opposingTeam('team2')).toBe('team1');
    expect(isTeamId('team1')).toBe(true);
    expect(isTeamId('spectator')).toBe(false);
    expect(describeTeam('team2')).toBe('Team 2');
  });
});

describe('throttle', () => {
  it('runs slow to flank, monotonically, for every hull', () => {
    for (const id of HULL_IDS) {
      const stats = getHull(id).stats;
      const speeds = THROTTLE_NOTCHES.map((notch) => throttleSpeedFor(stats, notch));
      for (let i = 1; i < speeds.length; i += 1) {
        expect(speeds[i]!).toBeGreaterThan(speeds[i - 1]!);
      }
    }
  });

  it('demands absolute speeds, not fractions: slow is a fixed five knots', () => {
    expect(throttleSpeedFor(STATS, 'slow')).toBeCloseTo(5 * KNOTS_TO_MPS);
    expect(throttleSpeedFor(STATS, 'flank')).toBe(STATS.maxSpeed);
  });

  it('sets full one knot under the cavitation line, for every hull', () => {
    for (const id of HULL_IDS) {
      const stats = getHull(id).stats;
      expect(throttleSpeedFor(stats, 'full')).toBeCloseTo(stats.cavitationSpeed - KNOTS_TO_MPS);
    }
  });

  it('marks the fastest notch that still stays quiet', () => {
    const notch = quietestLoudNotch(STATS);

    // The mark is *under* the threshold, and the next notch up is over it — that is what
    // makes it a line the player can hold themselves against (planning/08 §5).
    expect(throttleSpeedFor(STATS, notch)).toBeLessThanOrEqual(STATS.cavitationSpeed);
    const next = THROTTLE_NOTCHES[THROTTLE_NOTCHES.indexOf(notch) + 1];
    if (next !== undefined) {
      expect(throttleSpeedFor(STATS, next)).toBeGreaterThan(STATS.cavitationSpeed);
    }
  });

  it('cavitates above the threshold and not at it', () => {
    expect(isCavitating(STATS.cavitationSpeed, STATS)).toBe(false);
    expect(isCavitating(STATS.cavitationSpeed + 0.1, STATS)).toBe(true);
    expect(isCavitating(0, STATS)).toBe(false);
  });
});

describe('damage and value', () => {
  it('calls a boat damaged below half its hull integrity', () => {
    expect(isDamaged(boat({ hp: STATS.maxHp }))).toBe(false);
    expect(isDamaged(boat({ hp: STATS.maxHp * DAMAGED_HP_FRACTION }))).toBe(false);
    expect(isDamaged(boat({ hp: STATS.maxHp * DAMAGED_HP_FRACTION - 1 }))).toBe(true);
  });

  it('counts a damaged boat at half and a destroyed one at nothing', () => {
    // The deathmatch timer is decided on this arithmetic (planning/06 §2.1), so a boat that
    // is merely scratched must not be discounted and a wreck must not still be scoring.
    expect(survivingValue(boat())).toBe(120);
    expect(survivingValue(boat({ hp: 10 }))).toBe(60);
    expect(survivingValue(boat({ status: 'destroyed' }))).toBe(0);
    expect(survivingValue(boat({ hp: 10, status: 'destroyed' }))).toBe(0);
  });
});

describe('transients on a boat', () => {
  const TICK_HZ = 20;
  /** `bottoming` rings for six seconds — 120 ticks at 20 Hz. */
  const BOTTOMING_TICKS = TRANSIENTS.bottoming.seconds * TICK_HZ;

  it('rings for exactly as long as the table says', () => {
    const fired = { kind: 'bottoming' as const, tick: 100 };
    expect(isRinging(fired, 100, TICK_HZ)).toBe(true);
    expect(isRinging(fired, 100 + BOTTOMING_TICKS - 1, TICK_HZ)).toBe(true);
    expect(isRinging(fired, 100 + BOTTOMING_TICKS, TICK_HZ)).toBe(false);
  });

  it('records a bang with the tick it happened on', () => {
    const banged = withTransient(boat(), 'bottoming', 40, TICK_HZ);
    expect(banged.transients).toEqual([{ kind: 'bottoming', tick: 40 }]);
  });

  it('does not double up the same bang on the same tick', () => {
    // A boat that scrapes two walls inside one 50 ms step made one noise, and power-summing a bang
    // with itself would put 3 dB on the map that nothing in the world produced.
    const once = withTransient(boat(), 'bottoming', 40, TICK_HZ);
    expect(withTransient(once, 'bottoming', 40, TICK_HZ).transients).toHaveLength(1);
    expect(withTransient(once, 'bottoming', 41, TICK_HZ).transients).toHaveLength(2);
    expect(withTransient(once, 'collision', 40, TICK_HZ).transients).toHaveLength(2);
  });

  it('drops what has rung down, and hands the boat straight back when nothing has', () => {
    const banged = withTransient(boat(), 'bottoming', 40, TICK_HZ);

    expect(pruneTransients(banged, 41, TICK_HZ)).toBe(banged);
    expect(pruneTransients(banged, 40 + BOTTOMING_TICKS, TICK_HZ).transients).toEqual([]);
    // A boat with nothing ringing is never copied at all, which is most of the fleet every tick.
    const quiet = boat();
    expect(pruneTransients(quiet, 9_999, TICK_HZ)).toBe(quiet);
  });

  it('prunes on the way past when a new bang is added', () => {
    const old = withTransient(boat(), 'bottoming', 40, TICK_HZ);
    const fresh = withTransient(old, 'collision', 40 + BOTTOMING_TICKS, TICK_HZ);
    expect(fresh.transients).toEqual([{ kind: 'collision', tick: 40 + BOTTOMING_TICKS }]);
  });
});
