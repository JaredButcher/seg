/**
 * The registry — every map type mapped to its generator, and the entry point callers use.
 *
 * Only the Empty generator exists so far. Sparse and Dense are registered so the registry is
 * a complete map — `generateMap` fails loudly with a typed error, the same honest
 * `not_implemented` answer the lobby gives for `lobby.start`.
 */

import type { MapType } from '../lobby/settings.js';
import { emptyGenerator } from './empty.js';
import { MapGenerationError, type MapGenerator } from './generators.js';
import type { GeneratedMap, MapParams } from './types.js';

/** A placeholder that exists so the registry stays complete while a type has no generator yet. */
function notImplemented(type: MapType): MapGenerator {
  return {
    type,
    generate(): GeneratedMap {
      throw new MapGenerationError(
        'not_implemented',
        `the ${type} map generator is not implemented yet`,
      );
    },
  };
}

/** Every map type, mapped to its generator. Adding a type means adding a key here. */
export const GENERATORS: Readonly<Record<MapType, MapGenerator>> = {
  empty: emptyGenerator,
  sparse: notImplemented('sparse'),
  dense: notImplemented('dense'),
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
