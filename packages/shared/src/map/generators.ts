/**
 * The map generator contract — what a generator must provide.
 *
 * Each map type has its own generator behind one interface, so nothing downstream needs to
 * know which one produced a map. The generator is a pure function of its parameters
 * (planning/14 §5): the same `(seed, mapSize)` must always yield the same map, because the
 * server generates once and ships the geometry to clients, where a mismatch is a desync.
 *
 * The registry that maps types to generators lives in registry.ts; this file deliberately
 * imports no generator so the dependency only ever points one way.
 */

import type { MapType } from '../lobby/settings.js';
import type { GeneratedMap, MapParams } from './types.js';

/** The current generation logic. A map is content, so any logic change bumps this (planning/04 §9). */
export const GENERATOR_VERSION = 1;

/** A generator for one map type. `type` must match the registry key it lives under. */
export interface MapGenerator {
  readonly type: MapType;
  generate(params: MapParams): GeneratedMap;
}

export type MapGenerationErrorCode = 'unknown_map_type' | 'not_implemented';

/** A map could not be generated. Thrown, not returned: a failed match start is an error, not a state. */
export class MapGenerationError extends Error {
  constructor(
    readonly code: MapGenerationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MapGenerationError';
  }
}
