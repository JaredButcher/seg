import { describe, expect, it } from 'vitest';

import { ACOUSTIC_TICK_HZ, SIM_TICK_HZ, SIM_TICK_SECONDS } from '../src/index.js';

describe('@seg/shared', () => {
  it('exposes the tick rates from planning/04 §1', () => {
    expect(SIM_TICK_HZ).toBe(20);
    expect(ACOUSTIC_TICK_HZ).toBe(10);
  });

  it('runs the acoustic solve on exactly every second sim tick', () => {
    expect(SIM_TICK_HZ % ACOUSTIC_TICK_HZ).toBe(0);
    expect(SIM_TICK_HZ / ACOUSTIC_TICK_HZ).toBe(2);
  });

  it('derives a 50 ms fixed timestep', () => {
    expect(SIM_TICK_SECONDS).toBeCloseTo(0.05, 10);
  });
});
