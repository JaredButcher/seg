/**
 * Level fields — how far a sound has travelled to reach each part of the map.
 *
 * One bounded sweep out of a point, through water only. What comes back is the **geodesic path
 * length**: the distance sound actually had to swim, bending down passages and around
 * headlands rather than cutting through rock. Transmission loss is a function of that number
 * and nothing else (`content/acoustics.ts`), so this single field is the whole of propagation.
 *
 * ## One field, two jobs
 *
 * Path length is symmetric, so an entity's field serves as its **outbound** propagation — how
 * loud it is at every point — and, read the other way, as the **return leg** of anything it
 * hears. That is why the solve is linear in entities rather than quadratic in pairs: sixty
 * boats need sixty fields, not eighteen hundred.
 *
 * ## Buckets, not a heap
 *
 * The sweep is Dijkstra, but the priority queue is a bucket queue rather than a binary heap,
 * and that is worth a paragraph because it looks like an approximation and is not one.
 *
 * There are only two edge weights on the lattice — a step and a diagonal step — and the
 * smallest is the cell size. Bucket the frontier by `floor(range / cellSize)` and a node in
 * bucket `b` can only be improved by a node whose range is smaller, which is in bucket `b` or
 * earlier, *plus* an edge of at least one cell — landing it in bucket `b + 1` at the earliest.
 * So no improvement to a bucket can arrive while that bucket is being drained, and popping
 * within a bucket in any order gives exactly the same distances a heap would. What is bought
 * is an O(1) pop instead of a sixteen-step sift, on the single hottest loop in the game.
 *
 * ## Bounds, and why there are two
 *
 * A field is cut off by range and by cell count. The range bound is the honest one: past the
 * point where a sound has fallen under the quietest threshold in the match, following it
 * further changes no answer. The cell bound is the guardrail — a very loud source in a wide
 * open column can reach most of the map, and the tick budget (planning/03 §10) is not allowed
 * to depend on how the dice fell during map generation. Both are deterministic, so a replay
 * that hit the guardrail hits it again.
 *
 * ## The arena
 *
 * Fields are held for the length of one solve: the heatmap has to be finished before any
 * listener can be evaluated against it, so every field is computed first and read second.
 * Allocating them per tick would mean megabytes of garbage ten times a second, so the arena
 * owns its buffers, hands out `(offset, count)` handles, and is rewound rather than freed. The
 * handles are opaque on purpose — the arrays behind them are reallocated when they grow, so a
 * view handed out earlier would quietly go stale.
 */

import type { WaterLattice } from './lattice.js';

/** A field stored in an arena. Valid until the next `reset`. */
export interface FieldHandle {
  readonly offset: number;
  readonly count: number;
}

export interface FieldLimits {
  /** Stop following the sound past this path length, metres. */
  readonly maxRange: number;
  /** And past this many cells, whatever the range says. */
  readonly maxCells: number;
}

export class FieldArena {
  private readonly lattice: WaterLattice;

  /** Best known path length per cell, metres. `Infinity` where the sweep has not reached. */
  private readonly distance: Float64Array;
  /** Cells whose `distance` was written this sweep, so the reset touches only those. */
  private readonly touched: Int32Array;
  private touchedCount = 0;

  /** Bucket queue: heads into a flat entry arena, one bucket per cell-width of range. */
  private buckets: Int32Array;
  private entryCell: Int32Array;
  private entryKey: Float64Array;
  private entryNext: Int32Array;
  private entryCount = 0;

  private storeCells: Int32Array;
  private storeRanges: Float64Array;
  private offset = 0;

  /** Fields cut short by `maxCells` rather than by range, since the last `reset`. */
  clippedFields = 0;

  constructor(lattice: WaterLattice) {
    this.lattice = lattice;
    this.distance = new Float64Array(lattice.cellCount).fill(Infinity);
    this.touched = new Int32Array(lattice.cellCount);
    this.buckets = new Int32Array(256).fill(-1);
    this.entryCell = new Int32Array(1 << 14);
    this.entryKey = new Float64Array(1 << 14);
    this.entryNext = new Int32Array(1 << 14);
    this.storeCells = new Int32Array(1 << 16);
    this.storeRanges = new Float64Array(1 << 16);
  }

  /** Drops every field from the previous solve. The buffers stay. */
  reset(): void {
    this.offset = 0;
    this.clippedFields = 0;
  }

  /** How many cells this arena is currently holding, across every live field. */
  get storedCells(): number {
    return this.offset;
  }

  /**
   * Sweeps out from a world position and stores the result.
   *
   * The start cell is seeded with the true distance from the position to that cell's centre,
   * not with zero. Without it every source would sit exactly at its own cell centre and a boat
   * would be a little too loud on one side of the map and a little too quiet on the other; with
   * it the quantization shows up as a sub-cell offset rather than as a bias.
   *
   * A position inside rock is heard from the nearest water — a boat scraping a wall still makes
   * noise (`WaterLattice.waterIndexAt`).
   */
  solve(x: number, y: number, limits: FieldLimits): FieldHandle {
    const offset = this.offset;
    const start = this.lattice.waterIndexAt(x, y);
    if (start < 0) return { offset, count: 0 };

    const { cellSize, cols, rows } = this.lattice;
    const water = this.lattice.water;
    const diagonal = cellSize * Math.SQRT2;
    const bucketCount = Math.ceil(limits.maxRange / cellSize) + 2;
    this.prepare(bucketCount);

    const centre = this.lattice.centreOf(start);
    const seed = Math.hypot(x - centre.x, y - centre.y);

    this.touchedCount = 0;
    this.mark(start, seed);
    this.push(start, seed, cellSize, bucketCount);

    let count = 0;

    sweep: for (let b = 0; b < bucketCount; b += 1) {
      for (let entry = this.buckets[b] ?? -1; entry !== -1; entry = this.entryNext[entry] ?? -1) {
        const cell = this.entryCell[entry] ?? 0;
        const key = this.entryKey[entry] ?? Infinity;

        // A cell can be queued more than once; only the entry carrying its final distance
        // is the real one.
        if (key > (this.distance[cell] ?? Infinity)) continue;
        if (key > limits.maxRange) continue;
        if (count >= limits.maxCells) {
          this.clippedFields += 1;
          break sweep;
        }

        this.ensureStore(offset + count + 1);
        this.storeCells[offset + count] = cell;
        this.storeRanges[offset + count] = key;
        count += 1;

        const col = cell % cols;
        const row = (cell - col) / cols;

        for (let dr = -1; dr <= 1; dr += 1) {
          const r = row + dr;
          if (r < 0 || r >= rows) continue;
          for (let dc = -1; dc <= 1; dc += 1) {
            if (dr === 0 && dc === 0) continue;
            const c = col + dc;
            if (c < 0 || c >= cols) continue;
            const next = r * cols + c;
            if (water[next] !== 1) continue;
            // No cutting a corner: a diagonal step is only water if both of the orthogonal
            // steps it is made of are. Otherwise sound would leak through a wall that happens
            // to be sealed on the diagonal, which is exactly what this model forbids.
            if (dr !== 0 && dc !== 0) {
              if (water[row * cols + c] !== 1 || water[r * cols + col] !== 1) continue;
            }

            const step = key + (dr !== 0 && dc !== 0 ? diagonal : cellSize);
            if (step > limits.maxRange) continue;
            if (step >= (this.distance[next] ?? Infinity)) continue;
            this.mark(next, step);
            this.push(next, step, cellSize, bucketCount);
          }
        }
      }
    }

    for (let i = 0; i < this.touchedCount; i += 1) {
      this.distance[this.touched[i] ?? 0] = Infinity;
    }
    this.touchedCount = 0;

    this.offset = offset + count;
    return { offset, count };
  }

  /**
   * The `i`th cell of a field. Index `0` is always the cell the entity is standing in; after
   * that the order is by bucket, so ascending in range to within one cell width but not
   * strictly sorted. Nothing downstream needs it sorted, and requiring it would put the heap
   * back.
   */
  cellAt(handle: FieldHandle, i: number): number {
    return this.storeCells[handle.offset + i] ?? -1;
  }

  /** The path length to the `i`th cell, metres. */
  rangeAt(handle: FieldHandle, i: number): number {
    return this.storeRanges[handle.offset + i] ?? Infinity;
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  private prepare(bucketCount: number): void {
    if (this.buckets.length < bucketCount) this.buckets = new Int32Array(bucketCount);
    this.buckets.fill(-1, 0, bucketCount);
    this.entryCount = 0;
  }

  private mark(cell: number, value: number): void {
    if (this.distance[cell] === Infinity) this.touched[this.touchedCount++] = cell;
    this.distance[cell] = value;
  }

  private push(cell: number, key: number, cellSize: number, bucketCount: number): void {
    const bucket = Math.min(bucketCount - 1, (key / cellSize) | 0);

    if (this.entryCount === this.entryCell.length) {
      const size = this.entryCount * 2;
      const cells = new Int32Array(size);
      const keys = new Float64Array(size);
      const next = new Int32Array(size);
      cells.set(this.entryCell);
      keys.set(this.entryKey);
      next.set(this.entryNext);
      this.entryCell = cells;
      this.entryKey = keys;
      this.entryNext = next;
    }

    const entry = this.entryCount++;
    this.entryCell[entry] = cell;
    this.entryKey[entry] = key;
    this.entryNext[entry] = this.buckets[bucket] ?? -1;
    this.buckets[bucket] = entry;
  }

  private ensureStore(needed: number): void {
    if (needed <= this.storeCells.length) return;
    let size = this.storeCells.length;
    while (size < needed) size *= 2;
    const cells = new Int32Array(size);
    const ranges = new Float64Array(size);
    cells.set(this.storeCells);
    ranges.set(this.storeRanges);
    this.storeCells = cells;
    this.storeRanges = ranges;
  }
}
