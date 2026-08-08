/**
 * The Sparse and Dense generators — procedurally carved cave systems (planning/14).
 *
 * Both map types are the same pipeline with different tuning, which is what planning/14 §1.1
 * asks for: *"All three are the same world at different clutter levels, not different
 * biomes."* Sparse spends the available height on a few broad passages and big chambers;
 * Dense spends it on more routes, narrower, with more turns and more ways between them.
 *
 * ```
 *   seed ─► skeleton   routes across the map, laid out against the height budget
 *        ─► carve      the routes become discs, and the discs a signed field
 *        ─► contour    the field's zero crossing becomes rock polygons
 *        ─► measure    the polygons are read back and the guarantees checked
 * ```
 *
 * ## What is not here yet
 *
 * The convex sector decomposition, the portal graph, the per-hull navmesh, and the all-pairs
 * propagation precompute (planning/14 §5 steps 7–9) are absent. They are what acoustics and
 * navigation consume, and they belong with the simulation that will consume them; nothing
 * downstream can use them today. The contours this emits are the input those steps take, so
 * they are additive rather than a rewrite.
 *
 * There are also no free-standing pillars inside chambers. Everything here **only ever
 * removes rock**, which is precisely why the width floors cannot be violated by a later
 * stage. Putting rock back is what planning/14 I5 warns about, and it needs the clearance
 * re-erosion pass from §5 step 5 to be safe. Cheap to add later, wrong to add now.
 */

import { MapGenerationError, GENERATOR_VERSION, type MapGenerator } from './generators.js';
import { buildSkeleton } from './skeleton.js';
import { carveField } from './carve.js';
import { extractObstacles } from './contours.js';
import { TerrainRuler } from './measure.js';
import { depthScaleFor, resolveExtents } from './sizes.js';
import { resolveTuning, type CaveMapType } from './tuning.js';
import type { GeneratedMap, MapParams } from './types.js';

/**
 * The lattice the generator checks itself on.
 *
 * Coarser than the default measuring lattice, because this runs on every match start and only
 * has to answer two yes/no questions. Tools and tests that want the actual figures use
 * `measureTerrain`, which is finer and slower.
 */
const SELF_CHECK_CELL = 8;

export function createCaveGenerator(type: CaveMapType): MapGenerator {
  return {
    type,
    generate(params: MapParams): GeneratedMap {
      const { seed, mapSize } = params;
      const tuning = resolveTuning(type, params.tuning);
      const extents = resolveExtents(mapSize);

      const skeleton = buildSkeleton(extents, tuning, seed);
      const field = carveField(extents, skeleton.stamps, tuning.cellSize);
      const obstacles = extractObstacles(field, extents, {
        simplifyTolerance: tuning.simplifyTolerance,
        // A rock speck thinner than the walls the tuning asks for is noise from the lattice,
        // not terrain. Dropping one only ever widens the water, so no floor can be broken by
        // discarding it.
        minArea: tuning.nominalWallThickness * tuning.nominalWallThickness,
      });

      const map: GeneratedMap = {
        generatorVersion: GENERATOR_VERSION,
        seed,
        mapType: type,
        mapSize,
        extents,
        depthScale: depthScaleFor(extents),
        terrain: { obstacles },
      };

      // planning/14 §5 step 11: validation is a safety net, not the mechanism. "If it ever
      // fails in practice, that is a generator bug to fix, not a retry to tune" — so this
      // throws with the seed rather than quietly reseeding until something passes.
      const ruler = new TerrainRuler(extents, obstacles, { cellSize: SELF_CHECK_CELL });

      if (!ruler.hasOpeningAtLeast(tuning.minPassageWidth)) {
        throw new MapGenerationError(
          'invariant_violated',
          `${type} seed ${seed} (${mapSize}) carved an opening narrower than the ` +
            `${tuning.minPassageWidth} m floor`,
        );
      }

      if (!ruler.hasRouteAtLeast(tuning.trunkPassageWidth)) {
        throw new MapGenerationError(
          'invariant_violated',
          `${type} seed ${seed} (${mapSize}) has no end-to-end route ` +
            `${tuning.trunkPassageWidth} m wide`,
        );
      }

      return map;
    },
  };
}

export const sparseGenerator = createCaveGenerator('sparse');
export const denseGenerator = createCaveGenerator('dense');
