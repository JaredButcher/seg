/**
 * Carving — turning the skeleton's discs into a field the contour tracer can read.
 *
 * The field samples `min(|p − cᵢ| − rᵢ)` over the stamps: negative inside free water,
 * positive inside rock, zero on the boundary. That is the signed distance to the nearest
 * disc's surface, which for a union of discs is exactly the boundary we want and is smooth
 * between samples — so tracing it at iso-zero with linear interpolation gives curved cave
 * walls rather than the staircase a binary occupancy grid would produce.
 *
 * ## The lattice extends one sample beyond the map
 *
 * Rock runs right up to the top and bottom of the world (the surface and the seabed are hard
 * boundaries — planning/04 §6), so its outline genuinely touches the frame. A contour tracer
 * needs closed loops, and a loop that runs off the edge of its lattice is not closed.
 *
 * The fix is to sample one ring beyond the map and force that ring to free water. Every rock
 * region then closes just outside the world, and the tracer never meets an open end. The
 * vertices that stray outside are clamped back onto the frame afterwards (`contours.ts`),
 * which costs at most one cell of accuracy at the very edge and saves tracing the perimeter
 * by hand.
 */

import type { Stamp } from './skeleton.js';
import type { MapExtents } from './types.js';

export interface ScalarField {
  /** Samples across x and y. Sample (i, j) sits at `(originX + i·cellSize, originY + j·cellSize)`. */
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly originX: number;
  readonly originY: number;
  /** Row-major, `rows × cols`. Negative is free water, positive is rock. */
  readonly values: Float32Array;
}

/**
 * How far beyond a disc's own radius its samples are written.
 *
 * Two cells, because a sample adjacent to a free one must carry a real distance for the
 * crossing between them to interpolate correctly — and an adjacent sample is at most one
 * cell away, so two is comfortably enough. Beyond that the sample keeps the sentinel, which
 * is correct: it is deep rock, and no contour passes through it.
 */
const WRITE_MARGIN_CELLS = 2;

/** Deep rock. Any value well above the largest margin will do; this one keeps the field finite. */
const DEEP_ROCK = 1e6;

export function carveField(
  extents: MapExtents,
  stamps: readonly Stamp[],
  cellSize: number,
): ScalarField {
  const originX = -cellSize;
  const originY = -cellSize;
  const cols = Math.ceil(extents.width / cellSize) + 3;
  const rows = Math.ceil(extents.height / cellSize) + 3;

  const values = new Float32Array(cols * rows).fill(DEEP_ROCK);

  for (const stamp of stamps) {
    const reach = stamp.r + WRITE_MARGIN_CELLS * cellSize;

    const i0 = Math.max(0, Math.floor((stamp.x - reach - originX) / cellSize));
    const i1 = Math.min(cols - 1, Math.ceil((stamp.x - originX + reach) / cellSize));
    const j0 = Math.max(0, Math.floor((stamp.y - reach - originY) / cellSize));
    const j1 = Math.min(rows - 1, Math.ceil((stamp.y - originY + reach) / cellSize));

    for (let j = j0; j <= j1; j += 1) {
      const dy = originY + j * cellSize - stamp.y;
      const rowStart = j * cols;
      for (let i = i0; i <= i1; i += 1) {
        const dx = originX + i * cellSize - stamp.x;
        const signed = Math.sqrt(dx * dx + dy * dy) - stamp.r;
        const index = rowStart + i;
        if (signed < (values[index] ?? DEEP_ROCK)) values[index] = signed;
      }
    }
  }

  // The outer ring is water by decree, so every rock region closes inside the lattice.
  const outside = -cellSize;
  for (let i = 0; i < cols; i += 1) {
    values[i] = outside;
    values[(rows - 1) * cols + i] = outside;
  }
  for (let j = 0; j < rows; j += 1) {
    values[j * cols] = outside;
    values[j * cols + (cols - 1)] = outside;
  }

  return { cols, rows, cellSize, originX, originY, values };
}
