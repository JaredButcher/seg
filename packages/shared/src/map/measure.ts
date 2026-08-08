/**
 * Measuring a finished map — the independent half of the two width guarantees.
 *
 * `skeleton.ts` argues that a union of discs of radius `r` cannot contain an opening narrower
 * than `2r`. The argument is sound and it is still not evidence: the discs are rasterized
 * onto a lattice, traced as a contour, and simplified, and any of those three steps could
 * move a wall. So this module throws the construction away and starts from the **polygons the
 * generator actually emits**, rasterizing them back and measuring what is there.
 *
 * That independence is the point. planning/13 §4.1 asks for the invariants to be asserted
 * over hundreds of seeds; a check that re-derived the construction would pass on every one of
 * them while proving nothing.
 *
 * ## What is measured
 *
 * Both figures come from a distance transform of the rasterized rock. The **clearance** at a
 * point is twice its distance to the nearest rock — the width of the passage there, the
 * diameter of the largest disc that fits.
 *
 * - **Whether any opening is narrower than a stated width.** Free water contains no opening
 *   narrower than `w` exactly when every free point lies within `w/2` of a point whose
 *   clearance is at least `w`. That is the morphological opening test, and it is the honest
 *   reading of "no passage anywhere is tighter than this" — including the corner of a
 *   chamber, which is close to rock but is not a constriction. It answers a stated width
 *   rather than returning one, for the reason set out above `TerrainMeasurement`.
 * - **The widest end-to-end route.** The largest `w` for which cells of clearance `w` or more
 *   still connect the left edge of the map to the right. A boat of that beam can cross.
 *
 * ## The frame
 *
 * The top and bottom of the world are rock: the surface and the seabed are hard boundaries
 * (planning/04 §6), so a passage running along the seabed is bounded by it. The left and
 * right edges are not — routes leave through them, and walling them off would report every
 * route mouth as a dead end.
 */

import type { GeneratedMap, MapExtents, Obstacle } from './types.js';

/** Default lattice for measurement, metres. Finer than the carve grid, since this is the ruler. */
const DEFAULT_MEASURE_CELL = 5;

/** Widths are searched to this precision, metres. */
const SEARCH_PRECISION = 1;

export interface MeasureOptions {
  /** Lattice spacing, metres. Smaller is more precise and slower. */
  readonly cellSize?: number;
}

export interface TerrainMeasurement {
  /** The best left-to-right route's narrowest point, metres. Zero when the map is not crossable. */
  readonly widestRoute: number;
  /** Whether free water reaches from the left edge of the map to the right at all. */
  readonly crossable: boolean;
  /** The lattice the figures were measured on, so a caller can judge their precision. */
  readonly cellSize: number;
}

/*
 * There is deliberately no `narrowestOpening` figure here, only the `hasOpeningAtLeast`
 * predicate on the ruler.
 *
 * The opening property is *exactly tight at every wall*: in a passage `w` across, a point
 * touching the rock is precisely `w/2` from the nearest place a disc of width `w` fits, which
 * is precisely the limit. Every wall in the map therefore sits on the knife edge of the test,
 * and on a lattice the rounding at one of them decides the answer. Searching for "the width
 * at which it first fails" duly finds lattice noise: one seed measured 72 m on a 5 m lattice
 * and 133 m on an 8 m one, while the predicate answered true at 100 m and at 130 m on both.
 *
 * The predicate at a stated width is sound — the half-cell relaxation above makes a false
 * negative impossible — so that is what is offered. A caller who wants a figure asks the
 * question at the widths it cares about, and gets an answer it can rely on.
 */

/**
 * A ruler over one map's terrain. Built once and queried, because the rasterization and the
 * distance transform are the expensive part and every question reuses them.
 */
export class TerrainRuler {
  private readonly cols: number;
  /** Interior rows. The lattice carries one extra row top and bottom for the world's floor and ceiling. */
  private readonly rows: number;
  private readonly cellSize: number;
  /** Clearance in metres per cell, row-major over the padded lattice. Zero inside rock. */
  private readonly clearance: Float64Array;
  private readonly rock: Uint8Array;

  constructor(extents: MapExtents, obstacles: readonly Obstacle[], options: MeasureOptions = {}) {
    this.cellSize = options.cellSize ?? DEFAULT_MEASURE_CELL;
    this.cols = Math.max(1, Math.ceil(extents.width / this.cellSize));
    this.rows = Math.max(1, Math.ceil(extents.height / this.cellSize));

    this.rock = rasterize(obstacles, extents, this.cols, this.rows, this.cellSize);

    const distance = distanceTransform(this.rock, this.cols, this.rows + 2);
    this.clearance = new Float64Array(distance.length);
    for (let i = 0; i < distance.length; i += 1) {
      // Distances run centre to centre, so the rock's own half-cell is still counted as
      // water. Deducting it biases every figure low, which is the safe direction for
      // something a guarantee is asserted against.
      const metres = (distance[i] ?? 0) * this.cellSize - this.cellSize / 2;
      this.clearance[i] = this.rock[i] === 1 ? 0 : Math.max(0, metres * 2);
    }
  }

  /**
   * Free water contains no opening narrower than `width` — the morphological opening test:
   * every free point lies within `width / 2` of a point where a disc that wide fits.
   *
   * ### Why both bounds carry half a cell diagonal of slack
   *
   * The test is continuous but the lattice is not. A disc of radius `r` that genuinely fits
   * in the water is centred *somewhere*, and that somewhere is almost never a cell centre —
   * so a naive discrete core would miss it and the test would report a constriction that is
   * not there. The nearest cell centre to any point is within half a cell diagonal `h`, and
   * at that cell the clearance is at least `2(r − h)` while every point of the disc is within
   * `r + h` of it. Relaxing both bounds by `h` therefore makes a false negative impossible:
   * whenever the continuous property holds, this returns true.
   *
   * The price is a bounded false positive — the true narrowest may sit up to `2h` below the
   * width reported, about 7 m on the default 5 m lattice. That is the right way round for
   * something that gates a match start, and it is far inside the margin the generator carves
   * with.
   */
  hasOpeningAtLeast(width: number): boolean {
    const half = this.cellSize * Math.SQRT1_2;
    const coreClearance = width - 2 * half;

    const core = new Uint8Array(this.clearance.length);
    let coreCells = 0;
    let freeCells = 0;

    for (let i = 0; i < this.clearance.length; i += 1) {
      if (this.rock[i] === 1) continue;
      freeCells += 1;
      if ((this.clearance[i] ?? 0) >= coreClearance) {
        core[i] = 1;
        coreCells += 1;
      }
    }

    if (freeCells === 0) return true;
    if (coreCells === 0) return false;

    const reach = distanceTransform(core, this.cols, this.rows + 2);
    const limit = width / 2 + half;

    for (let i = 0; i < reach.length; i += 1) {
      if (this.rock[i] === 1) continue;
      if ((reach[i] ?? 0) * this.cellSize > limit) return false;
    }
    return true;
  }

  /**
   * The passage width at one point, metres — the diameter of the largest disc that fits
   * there. Zero inside rock, and zero outside the map.
   *
   * The lattice is already built and the distance transform already run, so this is an array
   * read. It exists for deployment placement (`match/deploy.ts`), which has to answer "does
   * this hull fit here" a few thousand times at match start and would otherwise need its own
   * rasterizer — a second implementation of the one thing this module exists to be the
   * authority on.
   */
  clearanceAt(x: number, y: number): number {
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return 0;
    // Interior rows sit at 1..rows in the padded lattice; row 0 and row rows+1 are the
    // seabed and the surface, which are rock.
    return this.clearance[(row + 1) * this.cols + col] ?? 0;
  }

  /** Cells of at least this clearance connect the left edge of the map to the right. */
  hasRouteAtLeast(width: number): boolean {
    const { cols, rows } = this;
    const passable = (index: number) =>
      this.rock[index] !== 1 && (this.clearance[index] ?? 0) >= width;

    const seen = new Uint8Array(this.clearance.length);
    const queue = new Int32Array(this.clearance.length);
    let head = 0;
    let tail = 0;

    // Interior rows are 1..rows in the padded lattice; the padding is rock and never enters.
    for (let r = 1; r <= rows; r += 1) {
      const index = r * cols;
      if (passable(index)) {
        seen[index] = 1;
        queue[tail++] = index;
      }
    }

    while (head < tail) {
      const index = queue[head++] ?? 0;
      const col = index % cols;
      if (col === cols - 1) return true;

      const neighbours = [index - 1, index + 1, index - cols, index + cols];
      for (let n = 0; n < neighbours.length; n += 1) {
        const next = neighbours[n] ?? -1;
        if (next < 0 || next >= seen.length) continue;
        // Horizontal steps must not wrap around a row end.
        if (n < 2 && Math.abs((next % cols) - col) !== 1) continue;
        if (seen[next] === 1 || !passable(next)) continue;
        seen[next] = 1;
        queue[tail++] = next;
      }
    }

    return false;
  }

  /**
   * The widest route across the map, found by bisecting `hasRouteAtLeast`.
   *
   * Bisection is meaningful here because that predicate is genuinely monotone: raising the
   * bar can only remove cells, and removing cells cannot create connectivity. The opening
   * property is not offered as a figure — see the note above the interface.
   */
  measure(): TerrainMeasurement {
    let ceiling = 0;
    for (let i = 0; i < this.clearance.length; i += 1) {
      const value = this.clearance[i] ?? 0;
      if (value > ceiling) ceiling = value;
    }

    return {
      widestRoute: bisect((w) => this.hasRouteAtLeast(w), ceiling),
      crossable: this.hasRouteAtLeast(0),
      cellSize: this.cellSize,
    };
  }
}

/** Convenience for a whole map. Builds a ruler and reads both figures off it. */
export function measureTerrain(map: GeneratedMap, options?: MeasureOptions): TerrainMeasurement {
  return new TerrainRuler(map.extents, map.terrain.obstacles, options).measure();
}

/** The largest width the predicate still holds at, to `SEARCH_PRECISION`. */
function bisect(holds: (width: number) => boolean, ceiling: number): number {
  if (!holds(0)) return 0;

  let low = 0;
  let high = ceiling + SEARCH_PRECISION;
  while (high - low > SEARCH_PRECISION) {
    const mid = (low + high) / 2;
    if (holds(mid)) low = mid;
    else high = mid;
  }
  return low;
}

/**
 * Scanline fill of the obstacle rings onto the lattice, with a rock row added above and below
 * the world.
 *
 * Even-odd within each ring, which is what makes a concave outline fill correctly. Obstacles
 * are unioned rather than combined into one crossing list, so two that happen to touch cannot
 * cancel each other out.
 *
 * ## The overhang
 *
 * The lattice covers a whole number of cells and the map does not, so the last row and column
 * can hang past the frame. Left alone, that overhang samples a place with no obstacles in it
 * and is filled as **water** — a one-cell film of free space running the whole width of the
 * map, outside the world, cut off from the real water by whatever rock is against the frame.
 *
 * That film is not a harmless artefact. It is free space with a clearance of one cell, nowhere
 * near anywhere a wide disc fits, so the opening test fails on it and the generator rejects a
 * map that is in fact fine. It went unnoticed because every map size divided evenly by the
 * measuring lattice until the base map grew: at a 3000 m base, `small` is 2100 m and `large`
 * 4500 m, and neither is a whole number of 8 m cells.
 */
function rasterize(
  obstacles: readonly Obstacle[],
  extents: MapExtents,
  cols: number,
  rows: number,
  cellSize: number,
): Uint8Array {
  const mask = new Uint8Array(cols * (rows + 2));

  // The surface and the seabed. Rock, so a passage running along either is measured against it.
  mask.fill(1, 0, cols);
  mask.fill(1, (rows + 1) * cols, (rows + 2) * cols);

  // Anything at or past the map's own edge is rock, for the same reason the frame is: it is
  // not water a boat could be in. The comparison is strict on purpose — a row centre landing
  // exactly on the boundary is the common case, since `ceil` puts it there whenever the height
  // is an odd multiple of half a cell, and the scanline is degenerate there: an obstacle edge
  // lying along the frame is half-open in y and counts as no crossing at all.
  for (let r = 0; r < rows; r += 1) {
    if ((r + 0.5) * cellSize < extents.height) continue;
    mask.fill(1, (r + 1) * cols, (r + 2) * cols);
  }
  for (let c = 0; c < cols; c += 1) {
    if ((c + 0.5) * cellSize < extents.width) continue;
    for (let r = 0; r < rows + 2; r += 1) mask[r * cols + c] = 1;
  }

  const crossings: number[] = [];

  for (let r = 0; r < rows; r += 1) {
    const y = (r + 0.5) * cellSize;
    const rowStart = (r + 1) * cols;

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

/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), in cell units.
 *
 * Two linear passes of a lower-envelope-of-parabolas sweep, one per axis. Exact rather than a
 * chamfer approximation because these distances are what a hard guarantee is checked against,
 * and a few per cent of error on a 100 m floor is metres of unearned slack.
 */
function distanceTransform(seeds: Uint8Array, cols: number, rows: number): Float64Array {
  const INF = 1e20;
  const squared = new Float64Array(cols * rows);

  for (let i = 0; i < squared.length; i += 1) squared[i] = seeds[i] === 1 ? 0 : INF;

  const length = Math.max(cols, rows);
  const f = new Float64Array(length);
  const d = new Float64Array(length);
  const v = new Int32Array(length);
  const z = new Float64Array(length + 1);

  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < rows; r += 1) f[r] = squared[r * cols + c] ?? INF;
    envelope(f, d, v, z, rows);
    for (let r = 0; r < rows; r += 1) squared[r * cols + c] = d[r] ?? INF;
  }

  for (let r = 0; r < rows; r += 1) {
    const rowStart = r * cols;
    for (let c = 0; c < cols; c += 1) f[c] = squared[rowStart + c] ?? INF;
    envelope(f, d, v, z, cols);
    for (let c = 0; c < cols; c += 1) squared[rowStart + c] = d[c] ?? INF;
  }

  const result = new Float64Array(squared.length);
  for (let i = 0; i < squared.length; i += 1) result[i] = Math.sqrt(squared[i] ?? 0);
  return result;
}

/** One-dimensional squared distance transform: the lower envelope of the sample parabolas. */
function envelope(
  f: Float64Array,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
  n: number,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;

  for (let q = 1; q < n; q += 1) {
    let s = intersection(f, v, k, q);
    while (k > 0 && s <= (z[k] ?? -Infinity)) {
      k -= 1;
      s = intersection(f, v, k, q);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }

  k = 0;
  for (let q = 0; q < n; q += 1) {
    while ((z[k + 1] ?? Infinity) < q) k += 1;
    const p = v[k] ?? 0;
    d[q] = (q - p) * (q - p) + (f[p] ?? 0);
  }
}

/** Where the parabolas rooted at `v[k]` and `q` cross. */
function intersection(f: Float64Array, v: Int32Array, k: number, q: number): number {
  const p = v[k] ?? 0;
  return ((f[q] ?? 0) + q * q - ((f[p] ?? 0) + p * p)) / (2 * q - 2 * p);
}
