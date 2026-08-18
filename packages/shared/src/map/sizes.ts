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
 * fixed game depth, `MAP_DEPTH` (1000 m — below the deepest hull crush depth even with a
 * pressure hull fitted, so depth can always bite). A map's `depthScale` normalizes its physical
 * height to that depth. A larger map therefore has *more Y field to play in* (height scales with
 * the map size, and scales *harder* than width — see `MAP_SIZE_SCALES`) while *still* reaching the
 * full depth range — and diving the same Δy costs more depth on a small map, where the scale is
 * steeper.
 *
 * **Depth counts down from the surface, so it runs against Y.** The map frame is y-up with the
 * seabed at `y = 0` (`types.ts`), while depth is what a hull's test and crush figures are
 * measured in and those are metres *below the surface*. The conversion is therefore
 * `depth = (height − y) · depthScale`: the surface is depth 0 and the seabed is `MAP_DEPTH`.
 * Reading it the other way round — which this file did until the match data model needed a
 * depth readout — puts a boat at the surface `MAP_DEPTH` down and inverts every depth line on
 * the scope.
 */

import type { MapSize } from '../lobby/settings.js';
import type { MapExtents } from './types.js';

/**
 * The fixed game depth (metres) shared by every map regardless of size. `y = extents.height`
 * (the surface) is depth 0; `y = 0` (the seabed) is `MAP_DEPTH` on every map. Depth is only
 * ever compared against test and crush depths and shown to the player; nothing else in the
 * game uses it as a position.
 *
 * The deepest a boat can be built to go is 860 m — a Medium's 680 m crush depth with a pressure
 * hull's +180 (`content/hulls.ts`, `content/modules.ts`) — so at 1000 m the seabed is still out
 * of reach of every hull in the game and the bottom of the map is still a wall made of pressure
 * rather than of rock. That margin is the whole requirement this number has to meet; it was
 * 1200, which met it with more room than the depth band was using.
 */
export const MAP_DEPTH = 1000;

/** The base map's X and Y extents — the `medium` scale (planning/14 §1). */
export const BASE_MAP_WIDTH = 10000;
export const BASE_MAP_HEIGHT = 4000;

/** How much a map size stretches the base map, per axis. */
export interface MapSizeScale {
  readonly width: number;
  readonly height: number;
}

/**
 * Extent multiplier per map size, **independent per axis** (planning/14 §1.2 records sizes as a
 * relative scale against the base map, which is what makes this tunable without a protocol
 * change).
 *
 * ## Why the two axes are not the same number
 *
 * They used to be — one scale applied to width and height alike. The reason they were split is
 * that the two directions do not buy the same thing. Map *width* is mostly transit: a wider map
 * is the same fight with a longer run-in to it, and past a point it is dead time on the clock.
 * Map *height* is where the interesting decisions are, because Y is the axis a boat trades
 * against — depth for speed, a level for cover, a shaft for an approach nobody is watching. More
 * Y field is more of the game; more X field is mostly more ocean.
 *
 * So height scales harder than width in both directions from the base. Large is 1.3× as wide but
 * 1.8× as tall; Small is 0.8× as wide but 0.6× as tall. A Large map is meaningfully *deeper* in
 * playable structure rather than merely longer, and a Small one is genuinely cramped vertically
 * — which is the pressure that makes a small map read as a small map.
 *
 * `depthScale` (below) absorbs the vertical stretch entirely, so none of this changes what a
 * given depth means for a hull: the seabed is `MAP_DEPTH` down on every size, and a boat still
 * dives at the same rate. What changes is how much room there is between the two.
 *
 * ## The floor on Small's height
 *
 * Cave tuning carries absolute metres — a level is at least `minPassageWidth` (200 m) tall and
 * sits on a `nominalWallThickness` (120 m) — while `levelMaxHeightShare` is a fraction of the
 * map. Small's height therefore cannot be shrunk freely: at 2400 m a Dense map's eight levels
 * need 8 × (200 + 120) = 2560 m of budget and the generator is already shortening them toward
 * the floor. Take this much below 0.6 and Dense starts dropping routes on Small instead, which
 * is a worse map rather than a smaller one. See `map/tuning.ts`.
 */
export const MAP_SIZE_SCALES: Readonly<Record<MapSize, MapSizeScale>> = {
  small: { width: 0.8, height: 0.6 },
  medium: { width: 1, height: 1 },
  large: { width: 1.3, height: 1.8 },
};

/** Resolves a map size to its physical X/Y extents. Deterministic and pure. */
export function resolveExtents(mapSize: MapSize): MapExtents {
  const scale = MAP_SIZE_SCALES[mapSize];
  return {
    width: Math.round(BASE_MAP_WIDTH * scale.width),
    height: Math.round(BASE_MAP_HEIGHT * scale.height),
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
