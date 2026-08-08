import { describe, expect, it } from 'vitest';

import { GENERATORS, MAP_TYPES, MapGenerationError, generateMap } from '../src/index.js';

describe('the generator registry', () => {
  it('has a generator for every map type', () => {
    expect(Object.keys(GENERATORS).sort()).toEqual([...MAP_TYPES].sort());
  });

  it('dispatches to the generator behind the requested type', () => {
    const map = generateMap('empty', { seed: 7, mapSize: 'small' });
    expect(map.mapType).toBe('empty');
    expect(map.generatorVersion).toBeGreaterThan(0);
  });
});

describe('generateMap', () => {
  it('produces a map of the type asked for, for every type', () => {
    for (const type of MAP_TYPES) {
      const map = generateMap(type, { seed: 1, mapSize: 'medium' });
      expect(map.mapType).toBe(type);
    }
  });

  it('throws a typed error for a type with no generator at all', () => {
    const failure = () =>
      generateMap('trench' as (typeof MAP_TYPES)[number], { seed: 1, mapSize: 'medium' });

    expect(failure).toThrow(MapGenerationError);
    try {
      failure();
      throw new Error('expected an error');
    } catch (error) {
      expect((error as MapGenerationError).code).toBe('unknown_map_type');
    }
  });
});
