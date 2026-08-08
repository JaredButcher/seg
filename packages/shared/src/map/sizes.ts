/**
 * Map dimensions and the depth scale — the magic numbers every map derives from.
 *
 * planning/14 §1.2 deliberately leaves exact dimensions unpinned and records sizes as a
 * relative scale against the base map, so the milestone can tune them without a protocol
 * change. This file is that tuning point: every number a generator needs lives here, and
 * adjusting a size is a diff in one place rather than a hunt through generators.
 *
 * **X/Y vs depth.** The map is 2D and everything in the game runs on X/Y: rendering, size,
 * movement. A sub that dives moves at the same speed on a small and a large map, visibly and
 * in simulation. The one thing X/Y does not represent is depth. Every map shares the same
 * fixed game depth, `MAP_DEPTH` (1200 m — comfortably below the deepest hull crush depth,
 * so depth can always bite). A map's `depthScale` normalizes its physical height to that
 * depth. A larger map therefore has *more Y field to play in* (height scales with the map
 * size) while *still* reaching the full depth range — and diving the same Δy costs more depth
 * on a small map, where the scale is steeper.
 *
 * **Depth counts down from the surface, so it runs against Y.** The map frame is y-up with the
 * seabed at `y = 0` (`types.ts`), while depth is what a hull's test and crush figures are
 * measured in and those are metres *below the surface*. The conversion is therefore
 * `depth = (height − y) · depthScale`: the surface is depth 0 and the seabed is `MAP_DEPTH`.
 * Reading it the other way round — which this file did until the match data model needed a
 * depth readout — puts a boat at the surface 1200 m down and inverts every depth line on the
 * scope.
 */

import type { MapSize } from '../lobby/settings.js';
import type { MapExtents } from './types.js';

/**
 * The fixed game depth (metres) shared by every map regardless of size. `y = extents.height`
 * (the surface) is depth 0; `y = 0` (the seabed) is `MAP_DEPTH` on every map. Depth is only
 * ever compared against test and crush depths and shown to the player; nothing else in the
 * game uses it as a position.
 */
export const MAP_DEPTH = 1200;

/** The base map's X and Y extents — the `medium` scale (planning/14 §1). */
export const BASE_MAP_WIDTH = 8000;
export const BASE_MAP_HEIGHT = 3000;

/**
 * Extent multiplier per map size (planning/14 §1.2: roughly 0.7× / 1× / 1.5×). Applied to
 * width and height alike: with the depth scale decoupling depth from Y, there is no longer
 * any reason to mute the vertical scaling, and a Large map should have substantially more Y
 * field than a Small one.
 */
export const MAP_SIZE_SCALES: Readonly<Record<MapSize, number>> = {
  small: 0.7,
  medium: 1,
  large: 1.5,
};

/** Resolves a map size to its physical X/Y extents. Deterministic and pure. */
export function resolveExtents(mapSize: MapSize): MapExtents {
  const scale = MAP_SIZE_SCALES[mapSize];
  return {
    width: Math.round(BASE_MAP_WIDTH * scale),
    height: Math.round(BASE_MAP_HEIGHT * scale),
  };
}

/**
 * How much game depth one Y metre is worth on a map of these extents. Derived, not a magic
 * number: it normalizes `extents.height` to `MAP_DEPTH`, so the seabed is exactly
 * `MAP_DEPTH` deep on every map size.
 */
export function depthScaleFor(extents: MapExtents): number {
  return MAP_DEPTH / extents.height;
}

/** The game depth at a Y position: `depth = (height − y) · depthScale`. Surface is 0. */
export function depthAt(extents: MapExtents, y: number): number {
  return (extents.height - y) * depthScaleFor(extents);
}

/** The Y position at which a boat is at the given game depth. The inverse of `depthAt`. */
export function yAt(extents: MapExtents, depth: number): number {
  return extents.height - depth / depthScaleFor(extents);
}
