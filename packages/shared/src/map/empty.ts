/**
 * The Empty map generator — open water.
 *
 * Trivial by design: this is the case that proves the generator interface out before any
 * procedural work exists. There is no rock to carve, so the terrain is an empty obstacle
 * list and the whole map is just the resolved extents of the requested size. It still takes
 * a seed and records it, keeping every generator on the same determinism contract — for
 * Empty the output happens to be seed-independent, which is fine: the contract is that the
 * same inputs yield the same output, not that every seed differs.
 */

import { depthScaleFor, resolveExtents } from './sizes.js';
import { GENERATOR_VERSION, type MapGenerator } from './generators.js';

export const emptyGenerator: MapGenerator = {
  type: 'empty',
  generate({ seed, mapSize }) {
    const extents = resolveExtents(mapSize);
    return {
      generatorVersion: GENERATOR_VERSION,
      seed,
      mapType: 'empty',
      mapSize,
      extents,
      depthScale: depthScaleFor(extents),
      terrain: { obstacles: [] },
    };
  },
};
