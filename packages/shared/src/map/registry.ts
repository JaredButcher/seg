/**
 * The registry — every map type mapped to its generator, and the entry point callers use.
 *
 * Open water, and the two carved cave systems. Sparse and Dense share one pipeline and differ
 * only in their tuning (`caves.ts`), which is why there is no third entry point here.
 */

import type { MapType } from '../lobby/settings.js';
import { denseGenerator, sparseGenerator } from './caves.js';
import { emptyGenerator } from './empty.js';
import { MapGenerationError, type MapGenerator } from './generators.js';
import type { GeneratedMap, MapParams } from './types.js';

/** Every map type, mapped to its generator. Adding a type means adding a key here. */
export const GENERATORS: Readonly<Record<MapType, MapGenerator>> = {
  empty: emptyGenerator,
  sparse: sparseGenerator,
  dense: denseGenerator,
};

/**
 * Generate a map of the requested type. The entry point the rest of the codebase uses —
 * resolves the size through the type's own generator rather than knowing anything about
 * sizes itself.
 */
export function generateMap(type: MapType, params: MapParams): GeneratedMap {
  const generator = GENERATORS[type];
  if (generator === undefined) {
    throw new MapGenerationError('unknown_map_type', `no map generator for ${String(type)}`);
  }
  const map = generator.generate(params);
  // Belt and braces against a generator that was misregistered under the wrong key.
  if (map.mapType !== type) {
    throw new Error(`map generator ${String(type)} returned a map of type ${map.mapType}`);
  }
  return map;
}
