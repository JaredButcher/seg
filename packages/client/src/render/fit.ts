/**
 * @seg/client/render/fit — how the map sits in the viewport.
 *
 * Pure and framework-free so the sizing rule is unit-testable without a canvas. The map is
 * drawn in its own coordinate frame (x right, y up, metres — `map/types.ts`), and `fitMap`
 * answers "what scale, and where does the map's lower-left corner land" for a viewport of
 * given pixel size. The caller is responsible for the y-up → screen-y flip; this only agrees
 * on the numbers.
 */

import type { MapExtents } from '@seg/shared';

/** How the map's axis-aligned box maps into a viewport, in CSS pixels. */
export interface FitTransform {
  /** Pixels per metre. The same on both axes, so shapes never distort. */
  readonly scale: number;
  /** Screen x of the map's left edge. */
  readonly offsetX: number;
  /** Screen y of the map's lower edge (the seabed), in the map's y-up frame. */
  readonly offsetY: number;
}

/**
 * Fit a map into a viewport, uniform-scale, centered, letterboxed.
 *
 * The map keeps its aspect ratio at all times; whichever dimension binds first gets padded.
 * `padding` shrinks the available box (CSS pixels) so a HUD can overlap the water without
 * covering the arena.
 */
export function fitMap(
  extents: MapExtents,
  viewport: { width: number; height: number },
  padding = 0,
): FitTransform {
  const innerWidth = Math.max(viewport.width - padding * 2, 1);
  const innerHeight = Math.max(viewport.height - padding * 2, 1);

  const scale = Math.min(innerWidth / extents.width, innerHeight / extents.height);

  return {
    scale,
    offsetX: (viewport.width - extents.width * scale) / 2,
    offsetY: (viewport.height - extents.height * scale) / 2,
  };
}
