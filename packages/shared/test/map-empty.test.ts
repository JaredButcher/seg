/**
 * Unit tests for the Empty map generator (planning/14 §1.1).
 *
 * The generator is the trivial case that proves the `MapGenerator` interface out, so these
 * assert the contract every future generator inherits: a pure, immutable function of
 * `(seed, mapSize)` that yields open water at the resolved extents. The dispatch through
 * `generateMap` is covered in map-generators.test.ts; here the generator is tested directly.
 */
import { describe, expect, it } from 'vitest';

import {
  GENERATOR_VERSION,
  MAP_DEPTH,
  MAP_SIZES,
  depthAt,
  depthScaleFor,
  emptyGenerator,
  resolveExtents,
} from '../src/index.js';

describe('emptyGenerator', () => {
  it('is registered under the map type it produces', () => {
    expect(emptyGenerator.type).toBe('empty');
  });

  it('yields open water — an empty obstacle list — for every map size', () => {
    for (const mapSize of MAP_SIZES) {
      const map = emptyGenerator.generate({ seed: 1, mapSize });
      expect(map.terrain).toEqual({ obstacles: [] });
    }
  });

  it('resolves the extents of the requested size', () => {
    for (const mapSize of MAP_SIZES) {
      const map = emptyGenerator.generate({ seed: 1, mapSize });
      expect(map.extents).toEqual(resolveExtents(mapSize));
    }
  });

  it('gives distinct sizes distinct extents', () => {
    const small = emptyGenerator.generate({ seed: 1, mapSize: 'small' }).extents;
    const medium = emptyGenerator.generate({ seed: 1, mapSize: 'medium' }).extents;
    const large = emptyGenerator.generate({ seed: 1, mapSize: 'large' }).extents;
    expect(small).not.toEqual(medium);
    expect(medium).not.toEqual(large);
    expect(small.width).toBeLessThan(medium.width);
    expect(medium.width).toBeLessThan(large.width);
  });

  it('produces exactly the documented shape and nothing more', () => {
    const map = emptyGenerator.generate({ seed: 42, mapSize: 'medium' });
    expect(map).toEqual({
      generatorVersion: GENERATOR_VERSION,
      seed: 42,
      mapType: 'empty',
      mapSize: 'medium',
      extents: resolveExtents('medium'),
      depthScale: depthScaleFor(resolveExtents('medium')),
      terrain: { obstacles: [] },
    });
  });

  it('stamps a depth scale that normalizes the map to the fixed game depth', () => {
    for (const mapSize of MAP_SIZES) {
      const map = emptyGenerator.generate({ seed: 1, mapSize });
      expect(map.depthScale).toBe(depthScaleFor(map.extents));
      // The seabed is the full game depth on every size, not a size-dependent value.
      expect(depthAt(map.extents, 0)).toBeCloseTo(MAP_DEPTH);
    }
  });

  it('records its inputs so the map can be regenerated or replayed', () => {
    const map = emptyGenerator.generate({ seed: 123456, mapSize: 'medium' });
    expect(map.generatorVersion).toBe(GENERATOR_VERSION);
    expect(map.seed).toBe(123456);
    expect(map.mapType).toBe('empty');
    expect(map.mapSize).toBe('medium');
  });

  it('preserves the seed exactly, including its edge values', () => {
    for (const seed of [0, 1, 2 ** 31 - 1, -7, Number.MAX_SAFE_INTEGER]) {
      expect(emptyGenerator.generate({ seed, mapSize: 'small' }).seed).toBe(seed);
    }
  });

  it('is deterministic: identical inputs yield an identical map', () => {
    const a = emptyGenerator.generate({ seed: 42, mapSize: 'large' });
    const b = emptyGenerator.generate({ seed: 42, mapSize: 'large' });
    expect(b).toEqual(a);
  });

  it('returns a fresh obstacle array on every call, so no output can mutate another', () => {
    const a = emptyGenerator.generate({ seed: 1, mapSize: 'medium' });
    const b = emptyGenerator.generate({ seed: 1, mapSize: 'medium' });
    expect(a.terrain.obstacles).not.toBe(b.terrain.obstacles);
  });

  it('accepts any seed without throwing', () => {
    for (const seed of [0, 1, 2 ** 31 - 1, 1234567890, -7]) {
      expect(() => emptyGenerator.generate({ seed, mapSize: 'medium' })).not.toThrow();
    }
  });
});
