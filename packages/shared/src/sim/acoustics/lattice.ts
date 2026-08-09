/**
 * The water lattice — the board every acoustic question is answered on.
 *
 * Sound travels through water and through nothing else, so the first thing the model needs is
 * a map of where the water is. That is this: the terrain polygons rasterized onto a coarse
 * grid, once at match start, and then never touched again.
 *
 * ## Why a grid, and not the sector/portal table
 *
 * planning/03 §5.2 proposes a precomputed sector-pair table: convex decomposition, Dijkstra
 * between sectors, an O(1) lookup per pair at runtime. That is the right structure for the
 * question *"how far is A from B"*, and the wrong one for the question this system actually
 * asks, which is **"which square metres of rock are lit up right now"**. A per-pair table has
 * no place to hang a per-square answer, and the number of squares is four orders of magnitude
 * larger than the number of sectors.
 *
 * A grid answers both. One bounded Dijkstra per entity gives that entity's path length to
 * every cell it can reach, which serves as its outbound propagation *and* — the same field,
 * read the other way — as the return leg of anything it hears. The cost is linear in entities
 * rather than quadratic, which is the property planning/03 §10 was reaching for.
 *
 * ## Resolution
 *
 * `ACOUSTICS.latticeCell` is 20 m. That is coarse next to the squares the system reports
 * (`VISION_CELL_SIZE`), and deliberately so: **the lattice decides detection, the skin decides
 * geometry**. A lit patch of wall is drawn from the contour trace, so it has the shape of the actual rock;
 * what is quantized to 20 m is only the brightness, and only at the frontier where brightness
 * is approaching zero anyway.
 *
 * The generator floors passages at `minPassageWidth` — 200 m — so even the tightest slot on
 * the map is a dozen cells across, and the geodesic distances are not being asked to squeeze
 * through anything comparable to a cell.
 *
 * ## Path length error
 *
 * Eight-connected Dijkstra overestimates a straight line by up to 5.7% (the octagon error). At
 * the model's spreading exponent that is 0.36 dB, which is beneath the resolution of anything
 * the player is shown and far beneath the tuning's own uncertainty. It is not corrected.
 */

import { ACOUSTICS } from '../../content/acoustics.js';
import { rasterizeObstacles } from '../../map/raster.js';
import type { MapExtents, Obstacle, Vec2 } from '../../map/types.js';

export interface LatticeOptions {
  /** Lattice spacing, metres. Defaults to `ACOUSTICS.latticeCell`. */
  readonly cellSize?: number;
}

export class WaterLattice {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly extents: MapExtents;

  /** `1` where the cell centre is open water — where sound, and a boat, can be. */
  readonly water: Uint8Array;

  /**
   * For every cell, the nearest cell that *is* water: itself when it is water, and the closest
   * one by breadth-first hops when it is rock.
   *
   * This exists for the reflectors. A square metre of wall is rock by definition, so it never
   * appears in any propagation field — but the sound that lights it arrives through the water
   * beside it, and the sound it returns leaves the same way. Binding each reflector to one
   * water cell is what lets a listener sweep its own field and find every surface it can see,
   * exactly once, with no neighbour search in the inner loop.
   *
   * `-1` only when the map holds no water at all.
   */
  readonly nearestWater: Int32Array;

  constructor(extents: MapExtents, obstacles: readonly Obstacle[], options: LatticeOptions = {}) {
    this.cellSize = options.cellSize ?? ACOUSTICS.latticeCell;
    this.extents = extents;
    this.cols = Math.max(1, Math.ceil(extents.width / this.cellSize));
    this.rows = Math.max(1, Math.ceil(extents.height / this.cellSize));

    const rock = rasterizeObstacles(obstacles, extents, this.cols, this.rows, this.cellSize);
    this.water = new Uint8Array(rock.length);
    for (let i = 0; i < rock.length; i += 1) this.water[i] = rock[i] === 1 ? 0 : 1;

    this.nearestWater = bindToWater(this.water, this.cols, this.rows);
  }

  get cellCount(): number {
    return this.cols * this.rows;
  }

  /** The cell a position falls in, or `-1` if it is off the map. Rock cells are returned as themselves. */
  indexAt(x: number, y: number): number {
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return -1;
    return row * this.cols + col;
  }

  /**
   * The water cell a position should be heard from — itself if it is in water, the nearest
   * water otherwise.
   *
   * The fallback is not defensive tidiness. A boat scraping a wall, a wreck settled into the
   * seabed, and a square metre of rock face are all *supposed* to be in rock, and all three
   * still have to emit and reflect.
   */
  waterIndexAt(x: number, y: number): number {
    const index = this.indexAt(x, y);
    return index < 0 ? -1 : (this.nearestWater[index] ?? -1);
  }

  colOf(index: number): number {
    return index % this.cols;
  }

  rowOf(index: number): number {
    return Math.floor(index / this.cols);
  }

  centreOf(index: number): Vec2 {
    return {
      x: (this.colOf(index) + 0.5) * this.cellSize,
      y: (this.rowOf(index) + 0.5) * this.cellSize,
    };
  }
}

/**
 * Multi-source breadth-first search out of every water cell at once, so each rock cell learns
 * which water cell is nearest it.
 *
 * Hop count rather than Euclidean distance, which is a slightly different "nearest" — and the
 * right one here. What a reflector needs is a water cell that genuinely adjoins it, not the
 * one a ruler would pick through forty metres of stone.
 *
 * Deterministic: the seed queue is in index order and the eight neighbours are visited in a
 * fixed order, so two runs over the same map produce the same array. Replays depend on it.
 */
function bindToWater(water: Uint8Array, cols: number, rows: number): Int32Array {
  const count = cols * rows;
  const nearest = new Int32Array(count).fill(-1);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < count; i += 1) {
    if (water[i] !== 1) continue;
    nearest[i] = i;
    queue[tail++] = i;
  }

  while (head < tail) {
    const index = queue[head++] ?? 0;
    const col = index % cols;
    const row = (index - col) / cols;
    const source = nearest[index] ?? -1;

    for (let dr = -1; dr <= 1; dr += 1) {
      const r = row + dr;
      if (r < 0 || r >= rows) continue;
      for (let dc = -1; dc <= 1; dc += 1) {
        const c = col + dc;
        if (c < 0 || c >= cols) continue;
        const next = r * cols + c;
        if (nearest[next] !== -1) continue;
        nearest[next] = source;
        queue[tail++] = next;
      }
    }
  }

  return nearest;
}
