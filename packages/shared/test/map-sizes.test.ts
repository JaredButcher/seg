import { describe, expect, it } from 'vitest';

import {
  BASE_MAP_HEIGHT,
  BASE_MAP_WIDTH,
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
    expect(resolveExtents('small').width).toBe(Math.round(BASE_MAP_WIDTH * MAP_SIZE_SCALES.small));
    expect(resolveExtents('large').width).toBe(Math.round(BASE_MAP_WIDTH * MAP_SIZE_SCALES.large));
  });

  it('scales height with the map size too, so larger maps get more Y field', () => {
    expect(resolveExtents('small').height).toBe(
      Math.round(BASE_MAP_HEIGHT * MAP_SIZE_SCALES.small),
    );
    expect(resolveExtents('large').height).toBe(
      Math.round(BASE_MAP_HEIGHT * MAP_SIZE_SCALES.large),
    );
    const small = resolveExtents('small');
    const large = resolveExtents('large');
    expect(large.height).toBeGreaterThan(small.height);
    expect(large.height / small.height).toBeGreaterThan(2);
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
    expect(medium).toBeCloseTo(1);
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
