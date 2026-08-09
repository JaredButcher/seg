/**
 * Active sonar, as an acoustic event (planning/03 §3).
 *
 * The claim these tests are defending is that **a ping is a transient and nothing more**. There
 * is no ping phase in the solver, no wavefront, and no echo queue; there is a boat that becomes
 * enormously loud for four tenths of a second, and every consequence — the cave walls lighting
 * up, the enemy getting a bearing — falls out of machinery that already existed. If that ever
 * stops being true, these are the tests that should have to change.
 */

import { describe, expect, it } from 'vitest';

import {
  ACOUSTICS,
  activePingLevel,
  deployMatch,
  generateMap,
  getHull,
  pingDue,
  pingLevelOf,
  resolveBoat,
  SIM_TICK_HZ,
  sourceLevelOf,
  ticksPerPing,
  type BoatState,
  type BoatTemplate,
} from '../src/index.js';

const MEDIUM: BoatTemplate = { name: 'S-01', hull: 'medium', modules: [] };

/** One deployed boat, so the state under test is the one the game actually produces. */
function boat(template: BoatTemplate = MEDIUM): BoatState {
  const state = deployMatch({
    matchId: 'm1',
    mode: 'deathmatch',
    map: generateMap('empty', { seed: 5, mapSize: 'small' }),
    startedAt: 0,
    players: [{ accountId: 'a', username: 'a', position: 'team1', boats: [template] }],
  });
  const first = state.boats[0];
  if (first === undefined) throw new Error('deployment produced no boats');
  return first;
}

describe('a pulse ringing down', () => {
  it('is at full strength the instant it fires', () => {
    expect(activePingLevel(120, 0)).toBe(120);
  });

  it('falls linearly to nothing across its length', () => {
    const half = ACOUSTICS.pingSeconds / 2;
    expect(activePingLevel(120, half)).toBeCloseTo(60, 6);
  });

  /*
   * `-Infinity` rather than zero, because zero is not silence on this scale — it is the level
   * of the quiet ocean (`content/acoustics.ts` header). A pulse that decayed to zero would go
   * on power-summing an ambient's worth of noise into its boat forever.
   */
  it('is silent once it has run out, and before it started', () => {
    expect(activePingLevel(120, ACOUSTICS.pingSeconds)).toBe(-Infinity);
    expect(activePingLevel(120, 99)).toBe(-Infinity);
    expect(activePingLevel(120, -0.1)).toBe(-Infinity);
  });

  it('rings down inside one interval, so pulses never overlap', () => {
    expect(ACOUSTICS.pingSeconds * 1000).toBeLessThan(ACOUSTICS.pingIntervalMs);
  });
});

describe('the pulse interval', () => {
  it('is two seconds, and forty sim ticks at the shipped rate', () => {
    expect(ACOUSTICS.pingIntervalMs).toBe(2000);
    expect(ticksPerPing(SIM_TICK_HZ)).toBe(40);
  });

  it('never rounds to zero, however slow the clock', () => {
    expect(ticksPerPing(1)).toBeGreaterThanOrEqual(1);
  });
});

describe('when a boat is due to pulse', () => {
  it('is never, with the switch off', () => {
    expect(pingDue({ ...boat(), activeSonar: false }, 1_000, SIM_TICK_HZ)).toBe(false);
  });

  /*
   * At once, which is the responsiveness of the whole control: a boat that has been passive has
   * already served the interval, so the switch is answered on the very next tick and the wait
   * is for the *second* pulse.
   */
  it('is at once on a boat that has never pinged', () => {
    const fresh = { ...boat(), activeSonar: true, lastPingTick: 0 };
    expect(pingDue(fresh, 1, SIM_TICK_HZ)).toBe(true);
    expect(pingDue(fresh, 600, SIM_TICK_HZ)).toBe(true);
  });

  /*
   * And that zero must not also read as a pulse. The two meanings share a value, so the one
   * place it matters — what the boat is *radiating* — has to say which it is, or a boat with
   * its sonar switched on at tick zero would broadcast a pulse that never happened.
   */
  it('has not already fired one, on a boat that has never pinged', () => {
    expect(pingLevelOf({ ...boat(), activeSonar: true, lastPingTick: 0 }, 2, SIM_TICK_HZ)).toBe(
      -Infinity,
    );
  });

  it('is one interval after the last pulse, and not before', () => {
    const pinging = { ...boat(), activeSonar: true, lastPingTick: 100 };
    expect(pingDue(pinging, 139, SIM_TICK_HZ)).toBe(false);
    expect(pingDue(pinging, 140, SIM_TICK_HZ)).toBe(true);
  });

  it('is never, on a wreck', () => {
    const dead = { ...boat(), activeSonar: true, lastPingTick: 0, status: 'destroyed' as const };
    expect(pingDue(dead, 500, SIM_TICK_HZ)).toBe(false);
    expect(pingLevelOf(dead, 500, SIM_TICK_HZ)).toBe(-Infinity);
  });
});

describe('what a pulse does to a boat’s source level', () => {
  it('is nothing at all while the switch is off', () => {
    expect(pingLevelOf({ ...boat(), activeSonar: false }, 0, SIM_TICK_HZ)).toBe(-Infinity);
  });

  /*
   * The number that matters. A stopped Medium radiates 48 dB; pinging it is 116, which is
   * roughly seventy decibels — a factor of ten million in power — above the boat it came out
   * of. "Pinging is always a map-wide announcement" (planning/03 §3) is not a rule anyone
   * wrote down in the solver; it is this arithmetic.
   */
  it('drowns out everything else the boat is doing', () => {
    const subject = { ...boat(), activeSonar: true, lastPingTick: 100 };
    const quiet = sourceLevelOf({ stats: subject.stats, speed: 0, depth: 200 });
    const ping = pingLevelOf(subject, 100, SIM_TICK_HZ);
    const loud = sourceLevelOf({
      stats: subject.stats,
      speed: 0,
      depth: 200,
      transients: [ping],
    });

    expect(ping).toBe(getHull('medium').stats.pingLevel);
    expect(loud).toBeGreaterThan(quiet + 60);
    // Power-summed rather than added: the pulse is so far above the hull noise that the sum is
    // the pulse, to within a hundredth of a decibel.
    expect(loud).toBeCloseTo(ping, 1);
  });

  it('is raised by Powerful Active Sonar, and by nothing else in the fleet editor', () => {
    const bare = resolveBoat(MEDIUM).current;
    const fitted = resolveBoat({
      ...MEDIUM,
      modules: [{ slot: 'equipment', index: 0, module: 'powerful-active-sonar' }],
    }).current;

    expect(fitted.pingLevel).toBe(bare.pingLevel + 8);
    // The trade is real and it is the *same number*: a pulse eight decibels stronger is a pulse
    // heard eight decibels further away. Nothing about the boat's own noise changed.
    expect(fitted.sourceLevel).toBe(bare.sourceLevel);
  });
});
