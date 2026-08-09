/**
 * The decibel layer: the arithmetic, the tuning table, and the four functions every other
 * part of the acoustic model is built out of.
 *
 * These are small, and they are the ones planning/13 §1 is talking about when it says the
 * failure modes here are silent. A transmission loss that is not monotone, a cavitation
 * threshold read the wrong way round, or decibels added with a `+` do not throw — they make
 * one hull class quietly undetectable, and nobody notices for three weeks.
 */

import {
  ACOUSTICS,
  addDecibels,
  cavitationSpeedAt,
  getHull,
  hullMaterial,
  MODULES,
  noiseFloorOf,
  rangeForLoss,
  returnThreshold,
  selfNoiseOf,
  sourceLevelOf,
  sumDecibels,
  toDecibels,
  toPower,
  transientLevel,
  transmissionLoss,
  TRANSIENTS,
  applyModifiers,
  type Stats,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

const MEDIUM: Stats = getHull('medium').stats;

describe('decibels', () => {
  it('adds in the power domain, not the log domain', () => {
    // The mistake this exists to prevent: two 40 dB sources are 43 dB, not 80.
    expect(addDecibels(40, 40)).toBeCloseTo(43.0103, 3);
    expect(sumDecibels([40, 40, 40, 40])).toBeCloseTo(46.0206, 3);
  });

  it('lets a much louder source swallow a quieter one', () => {
    // 20 dB down is one percent of the power, so it moves the total by ~0.04 dB.
    expect(addDecibels(60, 40)).toBeCloseTo(60.043, 2);
  });

  it('round-trips through the power ratio', () => {
    for (const db of [-30, -6, 0, 3, 17.5, 120]) {
      expect(toDecibels(toPower(db))).toBeCloseTo(db, 9);
    }
  });

  it('calls silence silence rather than zero', () => {
    expect(toDecibels(0)).toBe(-Infinity);
    expect(sumDecibels([])).toBe(-Infinity);
    expect(addDecibels(-Infinity, 12)).toBe(12);
  });
});

describe('transmission loss', () => {
  it('is zero at the reference range, because that is where a source level is quoted', () => {
    expect(transmissionLoss(ACOUSTICS.referenceRange)).toBe(0);
    // And nothing is louder than its own source level, however close you get.
    expect(transmissionLoss(0)).toBe(0);
    expect(transmissionLoss(1)).toBe(0);
  });

  it('rises with range, without exception', () => {
    let last = -1;
    for (let r = 0; r <= 6000; r += 25) {
      const loss = transmissionLoss(r);
      expect(loss).toBeGreaterThanOrEqual(last);
      last = loss;
    }
  });

  it('inverts', () => {
    for (const range of [50, 200, 600, 1500, 3500]) {
      const loss = transmissionLoss(range);
      expect(rangeForLoss(loss)).toBeCloseTo(range, 0);
    }
  });

  it('compresses the loud end, which is the whole reason absorption is so large', () => {
    // Spreading alone is a logarithm: 30 dB more source level would be a thousandfold in
    // range. The linear term is what turns it into a factor of about six, which is the
    // spread planning/03 §9's table actually asks for.
    const near = rangeForLoss(40);
    const far = rangeForLoss(70);
    expect(far / near).toBeGreaterThan(2.5);
    expect(far / near).toBeLessThan(9);
  });
});

describe('cavitation', () => {
  it('is the hull stat at the depth the hull stat is quoted at', () => {
    expect(cavitationSpeedAt(MEDIUM, ACOUSTICS.cavitationReferenceDepth)).toBeCloseTo(
      MEDIUM.cavitationSpeed,
      6,
    );
  });

  it('lets a boat go faster the deeper it is — the reason to dive', () => {
    const shallow = cavitationSpeedAt(MEDIUM, 50);
    const deep = cavitationSpeedAt(MEDIUM, 900);
    expect(deep).toBeGreaterThan(MEDIUM.cavitationSpeed);
    expect(shallow).toBeLessThan(MEDIUM.cavitationSpeed);
  });
});

describe('source level', () => {
  const at = (
    speed: number,
    depth = 300,
    extra: Partial<Parameters<typeof sourceLevelOf>[0]> = {},
  ) => sourceLevelOf({ stats: MEDIUM, speed, depth, ...extra });

  it('is the hull stat when stopped and shallow enough not to groan', () => {
    expect(at(0, 300)).toBeCloseTo(MEDIUM.sourceLevel, 6);
  });

  it('rises with the square of the speed fraction, so creep is genuinely quiet', () => {
    const creep = at(MEDIUM.maxSpeed * 0.2) - MEDIUM.sourceLevel;
    const half = at(MEDIUM.maxSpeed * 0.4) - MEDIUM.sourceLevel;
    expect(half / creep).toBeCloseTo(4, 5);
  });

  it('is a cliff at the cavitation threshold, not a slope', () => {
    const depth = 300;
    const threshold = cavitationSpeedAt(MEDIUM, depth);
    const under = at(threshold - 0.01, depth);
    const over = at(threshold + 0.01, depth);
    expect(over - under).toBeGreaterThan(ACOUSTICS.cavitationPenalty - 1);
  });

  it('gives the same speed away deeper, where the screw has stopped cavitating', () => {
    const speed = MEDIUM.cavitationSpeed * 1.3;
    expect(at(speed, 100)).toBeGreaterThan(at(speed, 1000) + 10);
  });

  it('makes a damaged boat, and a boat below test depth, permanently louder', () => {
    expect(at(0, 300, { damaged: true }) - at(0, 300)).toBeCloseTo(ACOUSTICS.damagedPenalty, 6);
    const deep = MEDIUM.testDepth + 50;
    expect(at(0, deep) - at(0, deep - 100)).toBeCloseTo(ACOUSTICS.hullStressPenalty, 6);
  });

  it('power-sums transients rather than adding them on', () => {
    const quiet = at(0, 300);
    const banging = at(0, 300, { transients: [quiet] });
    // Equal levels together are 3 dB, not double.
    expect(banging - quiet).toBeCloseTo(3.0103, 3);
  });
});

describe('transients', () => {
  it('decay from their peak to the ambient they are measured against', () => {
    const launch = TRANSIENTS['torpedo-launch'];
    expect(transientLevel('torpedo-launch', 0)).toBeCloseTo(launch.level, 6);
    expect(transientLevel('torpedo-launch', launch.seconds / 2)).toBeCloseTo(launch.level / 2, 6);
    expect(transientLevel('torpedo-launch', launch.seconds)).toBe(-Infinity);
  });

  it('rank the way planning/03 §3 ranks them: bottoming is the loudest mistake', () => {
    expect(TRANSIENTS.bottoming.level).toBeGreaterThan(TRANSIENTS['torpedo-launch'].level);
    expect(TRANSIENTS['torpedo-launch'].level).toBeGreaterThan(TRANSIENTS['hard-turn'].level);
  });
});

describe('the listening side', () => {
  it('deafens a boat that is going fast', () => {
    expect(selfNoiseOf(MEDIUM, MEDIUM.maxSpeed)).toBeGreaterThan(
      selfNoiseOf(MEDIUM, 0) + ACOUSTICS.selfNoiseSpan - 0.001,
    );
    expect(selfNoiseOf(MEDIUM, 0)).toBeCloseTo(ACOUSTICS.selfNoiseAtRest, 6);
  });

  it('never lets the noise floor fall below the ocean itself', () => {
    expect(noiseFloorOf(-Infinity, -Infinity)).toBeCloseTo(ACOUSTICS.ambientNoise, 6);
    expect(noiseFloorOf(-Infinity, -6)).toBeGreaterThan(ACOUSTICS.ambientNoise);
  });

  /*
   * The water around a listener counts at `backgroundNoiseFraction` of its power, so a din of
   * 30 dB lifts the floor to a shade over 27 rather than a shade over 30. Everything else in
   * the sum — the ocean, the boat's own machinery — is at full weight.
   */
  it('weighs the surrounding water at less than the whole of it', () => {
    const weighted = 30 + 10 * Math.log10(ACOUSTICS.backgroundNoiseFraction);

    expect(noiseFloorOf(30, -6)).toBeGreaterThan(weighted);
    expect(noiseFloorOf(30, -6)).toBeLessThan(30);
  });

  it('turns array gain into a lower bar rather than a louder signal', () => {
    const floor = noiseFloorOf(-Infinity, -6);
    const keen = returnThreshold(floor, MEDIUM.arrayGain + 4);
    const deaf = returnThreshold(floor, MEDIUM.arrayGain);
    expect(keen).toBeCloseTo(deaf - 4, 6);
  });
});

describe('materials', () => {
  it('reads a hull’s absorption off its target strength, in the right direction', () => {
    const light = hullMaterial(getHull('light').stats).absorption;
    const heavy = hullMaterial(getHull('heavy').stats).absorption;
    // A Heavy returns more of a ping than a Light, so it swallows less of one.
    expect(heavy).toBeLessThan(light);
  });

  it('makes an anechoic coating swallow more', () => {
    const bare = hullMaterial(MEDIUM).absorption;
    const coated = hullMaterial(
      applyModifiers(MEDIUM, MODULES['anechoic-coating'].modifiers),
    ).absorption;
    expect(coated).toBeGreaterThan(bare);
  });
});
