/**
 * The two ping-reach radii (`match/reach.ts`).
 *
 * These are inversions of the propagation model, so the test that matters is not "does it return a
 * plausible number" but **does the number satisfy the rule it was inverted out of**: put a source
 * at the radius this hands back and the arithmetic in `solve.ts` should land exactly on the gate.
 * Everything else here is the handful of properties a tester reads off the rings without thinking
 * about it — the inner one is inside the outer one, a louder pulse gets further, a keener listener
 * hears further — and the two ways of saying "nothing".
 */

import {
  ACOUSTICS,
  getHull,
  getWeapon,
  heardReach,
  hullMaterial,
  imagingReach,
  seekerEcho,
  seekerThreshold,
  transmissionLoss,
  type AcousticTuning,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

/** A boat's pulse and a listener sitting in quiet water: the ordinary case, in round numbers. */
const PULSE = 110;
const GATE = -5;
/** And a standard torpedo's seeker pulse, for the other receiver in the game. */
const PING = getWeapon('standard').seekerPingLevel;

const tuning: AcousticTuning = ACOUSTICS;

describe('the one-way reach', () => {
  it('lands where the arrival is exactly the listener’s gate', () => {
    // The claim the ring is making, checked against the rule it inverts: a source of `PULSE` at
    // this range arrives at the gate. Within a decibel, which is `rangeForLoss`'s own bisection
    // tolerance of half a metre.
    const range = heardReach(PULSE, GATE, tuning);
    expect(PULSE - transmissionLoss(range, tuning)).toBeCloseTo(GATE, 0);
  });

  it('gets further for a louder pulse, and further again for a keener ear', () => {
    const base = heardReach(PULSE, GATE, tuning);
    expect(heardReach(PULSE + 10, GATE, tuning)).toBeGreaterThan(base);
    // The half of it that is not about this boat at all: the same pulse carries further to
    // somebody who has slowed down to listen.
    expect(heardReach(PULSE, GATE - 10, tuning)).toBeGreaterThan(base);
  });

  it('is nothing at all when the pulse cannot clear the gate', () => {
    // Not `referenceRange`, which is what asking `rangeForLoss` for a loss of zero would give:
    // "nobody hears this" is a reading, and it is zero.
    expect(heardReach(GATE, GATE, tuning)).toBe(0);
    expect(heardReach(GATE - 20, GATE, tuning)).toBe(0);
  });

  it('stops where sound stops being followed at all', () => {
    expect(heardReach(400, GATE, tuning)).toBe(tuning.maxRange);
  });
});

describe('the two-way reach', () => {
  it('lands where the echo is exactly the gate, having paid the path twice and the rock once', () => {
    const range = imagingReach(PULSE, GATE, tuning.terrainAbsorption, tuning);
    const echo = PULSE - 2 * transmissionLoss(range, tuning) - tuning.terrainAbsorption;
    expect(echo).toBeCloseTo(GATE, 0);
  });

  it('is the seeker’s reach as readily as a hydrophone’s, given the seeker’s own two terms', () => {
    // The reason all three terms are the caller's: a homing torpedo hears its own echo off a
    // *hull*, against the flat threshold its receiver never gets quieter than, and that is the
    // same inversion rather than a second one (`sim/weapons/seeker.ts`).
    const stats = getHull('medium').stats;
    const gate = seekerThreshold(tuning);
    const absorption = hullMaterial(stats, tuning).absorption;
    const range = imagingReach(PING, gate, absorption, tuning);

    expect(seekerEcho(PING, range, stats, tuning)).toBeCloseTo(gate, 0);
  });

  it('reaches further off a hull that gives more back', () => {
    const gate = seekerThreshold(tuning);
    const soft = hullMaterial(getHull('light').stats, tuning).absorption;
    const loud = hullMaterial(getHull('heavy').stats, tuning).absorption;

    // A Heavy is the most reflective thing in the table, so it is the hull a seeker finds first.
    expect(loud).toBeLessThan(soft);
    expect(imagingReach(PING, gate, loud, tuning)).toBeGreaterThan(
      imagingReach(PING, gate, soft, tuning),
    );
  });

  it('is far shorter than the range the same pulse is heard at', () => {
    // The asymmetry the whole feature exists to show: a pulse announces you several times further
    // than it shows you anything, which is the trade a player makes by switching the sonar on.
    expect(imagingReach(PULSE, GATE, tuning.terrainAbsorption, tuning)).toBeLessThan(
      heardReach(PULSE, GATE, tuning) / 2,
    );
  });

  it('shrinks as the water round the listener gets noisier', () => {
    // What makes the inner ring worth watching rather than a constant: it is measured against the
    // platform's own gate, so anything that raises that — a teammate at flank, a bang, a hostile
    // pulse — pulls the circle in while the pulse itself is unchanged.
    const quiet = imagingReach(PULSE, GATE, tuning.terrainAbsorption, tuning);
    expect(imagingReach(PULSE, GATE + 20, tuning.terrainAbsorption, tuning)).toBeLessThan(quiet);
  });

  it('is nothing when the echo cannot clear the gate, absorption included', () => {
    // Loud enough to be heard one way, and still not loud enough to come back: the gap between
    // the two is exactly `terrainAbsorption` plus the second leg.
    const marginal = GATE + tuning.terrainAbsorption;
    expect(heardReach(marginal, GATE, tuning)).toBeGreaterThan(0);
    expect(imagingReach(marginal, GATE, tuning.terrainAbsorption, tuning)).toBe(0);
  });
});
