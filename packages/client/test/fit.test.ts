import { describe, expect, it } from 'vitest';

import { fitMap } from '../src/render/fit.js';

const MAP = { width: 5000, height: 1200 };

describe('fitMap', () => {
  it('scales uniformly and centres when the viewport is wider than the map', () => {
    const fit = fitMap(MAP, { width: 1000, height: 600 });

    // 1000 / 5000 = 0.2 binds, not 600 / 1200 = 0.5.
    expect(fit.scale).toBe(0.2);
    expect(fit.offsetX).toBe(0);
    expect(fit.offsetY).toBe((600 - 1200 * 0.2) / 2);
  });

  it('letterboxes on the top and bottom when the viewport is narrower than the map', () => {
    const fit = fitMap(MAP, { width: 500, height: 1000 });

    // 500 / 5000 = 0.1 binds, not 1000 / 1200 = 5 / 6 — the map is far wider than tall.
    expect(fit.scale).toBe(0.1);
    expect(fit.offsetX).toBe(0);
    expect(fit.offsetY).toBe((1000 - 1200 * 0.1) / 2);
  });

  it('shrinks the available box by the padding', () => {
    const unpadded = fitMap(MAP, { width: 1000, height: 600 });
    const padded = fitMap(MAP, { width: 1000, height: 600 }, 100);

    // 800 / 5000 = 0.16 vs 1000 / 5000 = 0.2.
    expect(padded.scale).toBe(0.16);
    expect(padded.scale).toBeLessThan(unpadded.scale);
  });

  it('never distorts: scale is shared by both axes', () => {
    const fit = fitMap(MAP, { width: 1234, height: 321 });

    // 1234 / 5000 = 0.2468 binds over 321 / 1200 = 0.2675.
    expect(fit.scale).toBe(1234 / 5000);
  });
});
