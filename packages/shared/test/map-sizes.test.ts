import { describe, expect, it } from 'vitest';

import {
  BASE_MAP_HEIGHT,
  BASE_MAP_WIDTH,
  CAVE_TUNING,
  MAP_DEPTH,
  MAP_SIZE_SCALES,
  MAP_SIZES,
  depthAt,
  depthScaleFor,
  resolveExtents,
  yAt,
} from '../src/index.js';

describe('resolveExtents', () => {
  it('treats medium as the base scale', () => {
    expect(resolveExtents('medium')).toEqual({ width: BASE_MAP_WIDTH, height: BASE_MAP_HEIGHT });
  });

  it('scales width linearly with the map size', () => {
    expect(resolveExtents('small').width).toBe(
      Math.round(BASE_MAP_WIDTH * MAP_SIZE_SCALES.small.width),
    );
    expect(resolveExtents('large').width).toBe(
      Math.round(BASE_MAP_WIDTH * MAP_SIZE_SCALES.large.width),
    );
  });

  it('scales height with the map size too, so larger maps get more Y field', () => {
    expect(resolveExtents('small').height).toBe(
      Math.round(BASE_MAP_HEIGHT * MAP_SIZE_SCALES.small.height),
    );
    expect(resolveExtents('large').height).toBe(
      Math.round(BASE_MAP_HEIGHT * MAP_SIZE_SCALES.large.height),
    );
    const small = resolveExtents('small');
    const large = resolveExtents('large');
    expect(large.height).toBeGreaterThan(small.height);
    expect(large.height / small.height).toBeGreaterThan(2);
  });

  /*
   * The point of splitting the two axes (`map/sizes.ts#MAP_SIZE_SCALES`): Y is the axis a boat
   * trades against, so a size step has to move it further than it moves X. Written as a
   * relationship rather than against the shipped figures — this is the property the split exists
   * to guarantee, and it should survive the next time the numbers are tuned.
   */
  it('scales height harder than width, in both directions from the base', () => {
    expect(MAP_SIZE_SCALES.medium).toEqual({ width: 1, height: 1 });

    // Large: taller by more than it is wider.
    expect(MAP_SIZE_SCALES.large.height).toBeGreaterThan(MAP_SIZE_SCALES.large.width);
    // Small: shorter by more than it is narrower.
    expect(MAP_SIZE_SCALES.small.height).toBeLessThan(MAP_SIZE_SCALES.small.width);

    // And so the aspect ratio genuinely changes with the size, rather than the whole map being
    // one shape at three zoom levels — which is what it was before the axes were split.
    const ratio = (size: 'small' | 'medium' | 'large') => {
      const extents = resolveExtents(size);
      return extents.width / extents.height;
    };
    expect(ratio('small')).toBeGreaterThan(ratio('medium'));
    expect(ratio('medium')).toBeGreaterThan(ratio('large'));
  });

  /*
   * The floor `map/tuning.ts` documents: cave levels carry absolute metres (a 200 m minimum
   * passage on a 120 m nominal wall), so a Small map has to stay tall enough to stack the routes
   * the densest generator asks for. This is the assertion that catches a vertical scale tuned
   * past what the generator can fill.
   */
  it('leaves a Small map tall enough for the densest generator to stack its levels', () => {
    const budget =
      Math.max(...Object.values(CAVE_TUNING).map((tuning) => tuning.routeCount)) *
      (Math.max(...Object.values(CAVE_TUNING).map((tuning) => tuning.minPassageWidth)) +
        Math.max(...Object.values(CAVE_TUNING).map((tuning) => tuning.nominalWallThickness)));

    // Within a wall's thickness of the budget: the generator shortens middling levels toward the
    // floor before it drops any, so it does not need the full nominal stack to keep its routes.
    expect(resolveExtents('small').height).toBeGreaterThan(budget - 200);
  });

  it('returns positive integers for every size', () => {
    for (const size of MAP_SIZES) {
      const extents = resolveExtents(size);
      expect(Number.isInteger(extents.width)).toBe(true);
      expect(Number.isInteger(extents.height)).toBe(true);
      expect(extents.width).toBeGreaterThan(0);
      expect(extents.height).toBeGreaterThan(0);
    }
  });
});

describe('the depth scale', () => {
  it('is the fixed depth normalized onto the map height', () => {
    for (const size of MAP_SIZES) {
      const extents = resolveExtents(size);
      expect(depthScaleFor(extents)).toBeCloseTo(MAP_DEPTH / extents.height);
    }
  });

  it('makes every map reach the same depth at its seabed, regardless of size', () => {
    for (const size of MAP_SIZES) {
      const extents = resolveExtents(size);
      // Depth counts down from the surface, so it runs against Y: the top of the frame is
      // depth 0 and the seabed is the full game depth.
      expect(depthAt(extents, extents.height)).toBe(0);
      expect(depthAt(extents, 0)).toBeCloseTo(MAP_DEPTH);
    }
  });

  it('is steeper on a small map, so diving the same Δy costs more depth there', () => {
    const small = depthScaleFor(resolveExtents('small'));
    const medium = depthScaleFor(resolveExtents('medium'));
    const large = depthScaleFor(resolveExtents('large'));
    expect(small).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(large);
    // The base map is 4000 m of Y against 1200 m of game depth, so one Y metre is well
    // under one metre of depth on it — and steeper than that on anything smaller.
    expect(medium).toBeCloseTo(MAP_DEPTH / BASE_MAP_HEIGHT);
  });

  it('round-trips between Y and depth', () => {
    for (const size of MAP_SIZES) {
      const extents = resolveExtents(size);
      for (const y of [0, 100, 450, extents.height]) {
        expect(yAt(extents, depthAt(extents, y))).toBeCloseTo(y);
      }
    }
  });
});
