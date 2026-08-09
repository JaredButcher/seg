/**
 * How a boat's propellers are voiced — the arithmetic, not the oscillators.
 *
 * `voicingFor` is the whole audible model and it is deliberately pure, so the part that decides
 * "does a Heavy sound bigger than a Light, and does the throttle make a difference" can be tested
 * without a Web Audio context. What is left in `PropellerVoices` after that is node plumbing, and
 * a test of node plumbing against a mock `AudioContext` would test the mock.
 */

import { getHull, HULL_IDS } from '@seg/shared';
import { describe, expect, it } from 'vitest';

import { hullSizeFraction, hullWeight, voicingFor } from '../src/audio/propeller.js';

const FLANK = (hull: 'light' | 'medium' | 'heavy'): number => getHull(hull).stats.maxSpeed;

describe('hull size', () => {
  it('runs from the shortest hull to the longest, read off the table', () => {
    expect(hullSizeFraction('light')).toBe(0);
    expect(hullSizeFraction('heavy')).toBe(1);
    expect(hullSizeFraction('medium')).toBeGreaterThan(0);
    expect(hullSizeFraction('medium')).toBeLessThan(1);
  });

  it('never silences the smallest boat', () => {
    // A Light hitting a wall is quieter than a Heavy hitting one, and is not inaudible.
    for (const id of HULL_IDS) expect(hullWeight(id)).toBeGreaterThan(0.5);
    expect(hullWeight('heavy')).toBeGreaterThan(hullWeight('light'));
  });
});

describe('the blade rate', () => {
  it('is lower on a bigger hull — a bigger screw turns more slowly', () => {
    const light = voicingFor('light', 0, false).bladeHz;
    const medium = voicingFor('medium', 0, false).bladeHz;
    const heavy = voicingFor('heavy', 0, false).bladeHz;

    expect(light).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(heavy);
  });

  it('rises with speed, so a boat winding up can be heard doing it', () => {
    const stopped = voicingFor('medium', 0, false).bladeHz;
    const flank = voicingFor('medium', FLANK('medium'), false).bladeHz;
    expect(flank).toBeGreaterThan(stopped);
  });
});

describe('how loud a propeller is', () => {
  it('rises with the throttle, and quadratically — the same curve the sim uses', () => {
    const half = voicingFor('medium', FLANK('medium') / 2, false).humGain;
    const flank = voicingFor('medium', FLANK('medium'), false).humGain;
    const idle = voicingFor('medium', 0, false).humGain;

    expect(flank).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(idle);
    // `flowNoiseSpan · f²` is the model's own shape (`sourceLevelOf`); half speed should therefore
    // be nearer the idle end than the midpoint, not halfway up.
    expect(half - idle).toBeLessThan((flank - idle) / 2);
  });

  it('leaves a stopped boat audible but faint', () => {
    const idle = voicingFor('medium', 0, false).humGain;
    expect(idle).toBeGreaterThan(0);
    expect(idle).toBeLessThan(voicingFor('medium', FLANK('medium'), false).humGain / 4);
  });

  it('is louder on a bigger hull at the same speed', () => {
    const light = voicingFor('light', 5, false).humGain;
    const heavy = voicingFor('heavy', 5, false).humGain;
    expect(heavy).toBeGreaterThan(light);
  });

  it('never runs away, whatever it is handed', () => {
    expect(voicingFor('medium', 1e6, false).humGain).toBeCloseTo(
      voicingFor('medium', FLANK('medium'), false).humGain,
    );
    expect(voicingFor('medium', -5, false).humGain).toBeGreaterThan(0);
  });
});

describe('the cavitation hiss', () => {
  it('is absent below the line and substantial the instant it is crossed', () => {
    const quiet = voicingFor('medium', getHull('medium').stats.cavitationSpeed, false);
    const screaming = voicingFor('medium', getHull('medium').stats.cavitationSpeed + 0.1, true);

    expect(quiet.hissGain).toBe(0);
    // A cliff, not a slope: crossing the threshold has to be an event the player hears, because
    // it is the single most important number they track (planning/03 §3).
    expect(screaming.hissGain).toBeGreaterThan(screaming.humGain / 2);
  });

  it('keeps the blade rate underneath it — the screw is still turning', () => {
    const screaming = voicingFor('medium', FLANK('medium'), true);
    expect(screaming.humGain).toBeGreaterThan(0);
  });

  it('gets worse the faster the boat goes', () => {
    const over = voicingFor('medium', getHull('medium').stats.cavitationSpeed + 0.1, true).hissGain;
    const flat = voicingFor('medium', FLANK('medium'), true).hissGain;
    expect(flat).toBeGreaterThan(over);
  });

  it('is louder on a bigger hull, like everything else about it', () => {
    expect(voicingFor('heavy', 10, true).hissGain).toBeGreaterThan(
      voicingFor('light', 10, true).hissGain,
    );
  });
});
