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
  it('throws a typed error for a map type whose generator does not exist yet', () => {
    for (const type of ['sparse', 'dense'] as const) {
      const failure = () => generateMap(type, { seed: 1, mapSize: 'medium' });
      expect(failure).toThrow(MapGenerationError);
      try {
        failure();
        throw new Error('expected an error');
      } catch (error) {
        expect(error).toBeInstanceOf(MapGenerationError);
        expect((error as MapGenerationError).code).toBe('not_implemented');
        expect((error as MapGenerationError).message).toContain(type);
      }
    }
  });
});
