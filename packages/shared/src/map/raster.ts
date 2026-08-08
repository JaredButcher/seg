/**
 * Putting the terrain polygons back onto a lattice — the one routine that decides where the
 * rock is.
 *
 * Two systems need this and they must never disagree. `measure.ts` rasterizes to check the
 * generator's width guarantees; `sim/acoustics` rasterizes to decide where sound can go. If
 * one of them thought a cell was water and the other thought it was rock, the map would pass
 * its own audit and then block a sound in a passage a boat can swim down — the kind of
 * mismatch that reads as an acoustic bug for a week before anyone suspects the raster.
 *
 * ## The rule
 *
 * A cell is rock when **its centre** lies inside an obstacle. Not "overlaps"; not "is mostly".
 * Centre sampling is what makes the result agree with a point query — `clearanceAt(x, y)` and
 * "can sound be here" are answering about a position, and a cell that counted as rock because
 * one corner clipped a wall would put a boat inside stone.
 *
 * Even-odd within each ring, so a concave outline fills correctly, and obstacles are unioned
 * one at a time rather than merged into a single crossing list — two rings that happen to
 * touch must not cancel each other out.
 *
 * ## The overhang
 *
 * The lattice covers a whole number of cells and the map does not, so the last row and column
 * can hang past the frame. Left alone that overhang samples a place with no obstacles in it
 * and fills as **water** — a one-cell film of free space outside the world, cut off from the
 * real water by whatever rock is against the frame. It is not harmless: it is free space one
 * cell wide, so the opening test fails on it and a perfectly good map is rejected. Anything at
 * or past the map's own edge is therefore rock.
 *
 * The comparison is strict on purpose. A row centre landing exactly on the boundary is the
 * common case — `ceil` puts it there whenever the extent is an odd multiple of half a cell —
 * and the scanline is degenerate there: an obstacle edge lying along the frame is half-open in
 * y and counts as no crossing at all.
 */

import type { MapExtents, Obstacle } from './types.js';

/**
 * Marks every cell whose centre is inside an obstacle, or outside the map.
 *
 * Row-major, `cols × rows`, `1` for rock and `0` for water. The caller chooses the lattice;
 * this only fills it.
 */
export function rasterizeObstacles(
  obstacles: readonly Obstacle[],
  extents: MapExtents,
  cols: number,
  rows: number,
  cellSize: number,
): Uint8Array {
  const mask = new Uint8Array(cols * rows);

  for (let r = 0; r < rows; r += 1) {
    if ((r + 0.5) * cellSize < extents.height) continue;
    mask.fill(1, r * cols, (r + 1) * cols);
  }
  for (let c = 0; c < cols; c += 1) {
    if ((c + 0.5) * cellSize < extents.width) continue;
    for (let r = 0; r < rows; r += 1) mask[r * cols + c] = 1;
  }

  const crossings: number[] = [];

  for (let r = 0; r < rows; r += 1) {
    const y = (r + 0.5) * cellSize;
    const rowStart = r * cols;

    for (const obstacle of obstacles) {
      crossings.length = 0;
      const { vertices } = obstacle;

      for (let i = 0; i < vertices.length; i += 1) {
        const a = vertices[i];
        const b = vertices[(i + 1) % vertices.length];
        if (a === undefined || b === undefined) continue;
        // Half-open in y, so a vertex exactly on the scanline is counted once rather than
        // twice — the classic double-count that leaves holes in a filled polygon.
        if (a.y <= y === b.y <= y) continue;
        crossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }

      if (crossings.length < 2) continue;
      crossings.sort((p, q) => p - q);

      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = crossings[k] ?? 0;
        const to = crossings[k + 1] ?? 0;
        const first = Math.max(0, Math.ceil(from / cellSize - 0.5));
        const last = Math.min(cols - 1, Math.floor(to / cellSize - 0.5));
        for (let c = first; c <= last; c += 1) mask[rowStart + c] = 1;
      }
    }
  }

  return mask;
}
