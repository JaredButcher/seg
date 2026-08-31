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
 *
 * ## Graph distance, and the seed (planning/16 §3.1)
 *
 * The sweep runs from **zero** at the start cell and what it stores is pure graph distance. The
 * true distance from the source to its own cell's centre — the *seed* — rides on the handle and
 * is added by `rangeAt`, on every path, always.
 *
 * That split is what makes a field cacheable, and it is not free-form. A field's ranges are
 * exactly `seed + graphDistance(startCell, cell)` (checked over 1.3 M cell-ranges by
 * `bench:acoustics:invariant`, worst deviation 9.1 × 10⁻¹³ m), so the sweep depends only on
 * *which cell* the source is in and not on where inside it the source sits. Two boats in one
 * cell, or one boat that has not left its cell since the last solve, want the same sweep.
 *
 * The seed is added at read time rather than accumulated through the sweep because accumulating
 * it and adding it afterwards are not bit-identical, and `factorAt` floors range into a 1 m
 * table where that difference is invisible *until* a range lands within 10⁻¹² of an integer.
 * If a cache hit returned one and a miss the other, which a solve got would depend on where the
 * boat had been on previous ticks — history leaking into the heatmap, the exact class of bug
 * `solve.ts` sorts its entity list to avoid. One path for both, so the cache is unobservable.
 */

import type { WaterLattice } from './lattice.js';

/** A field stored in an arena. Valid until the next `reset`. */
export interface FieldHandle {
  readonly offset: number;
  readonly count: number;
  /**
   * Distance from the source to its own cell's centre, metres — the constant every stored range
   * is short by, because the sweep runs in graph distance. `rangeAt` adds it; nothing else should.
   */
  readonly seed: number;
}

export interface FieldLimits {
  /** Stop following the sound past this path length, metres. */
  readonly maxRange: number;
  /** And past this many cells, whatever the range says. */
  readonly maxCells: number;
}

export interface FieldArenaOptions {
  /**
   * Reuse swept fields across solves, keyed on the start cell (planning/16 §3.1). On by default.
   *
   * Turn it **off** for anything measuring or checking the sweep itself: a harness that validates
   * the cache's own invariant must not be answered by the cache (`bench:acoustics:invariant`), and
   * a benchmark of sweep cost wants every solve to be a real sweep.
   */
  readonly cache?: boolean;
  /**
   * Cells the cache may hold before the least recently used field is dropped.
   *
   * A 1200 m field on a 20 m lattice is ≈ 8 600 cells at 12 B each, so the default is a little
   * over 4 MB — comfortably more than a full fleet's live fields, and enough slack that the stale
   * entries a moving boat leaves behind are evicted rather than thrashing.
   */
  readonly cacheCells?: number;
}

/** One cached sweep. Owns its own arrays, so eviction is a `Map.delete` and nothing more. */
interface CachedField {
  /** Cells, and their graph distances in metres, in the order the sweep stored them. */
  readonly cells: Int32Array;
  readonly ranges: Float64Array;
  readonly count: number;
  /** How far this sweep actually went. Usable for any request no further out than this. */
  readonly radius: number;
  /** The cell bound it was swept under, since a tighter one would have stopped it sooner. */
  readonly maxCells: number;
}

/**
 * How far a cached radius is rounded up, in cell widths.
 *
 * Most fields are sized by `maxImagingRange` and land on exactly the same radius every solve, so
 * this usually rounds to itself and costs nothing. It earns its keep on the entities whose reach
 * moves with their source level — a boat changing speed — where without it a metre of drift would
 * miss the cache on every solve. Two cells of slack against `r²` is under a percent of extra
 * sweep at imaging range.
 */
const RADIUS_GRAIN_CELLS = 2;

const DEFAULT_CACHE_CELLS = 350_000;

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

  /** Scratch a miss sweeps into, before the cache decides whether to keep a copy. */
  private sweepCells: Int32Array;
  private sweepRanges: Float64Array;

  /** The lattice's neighbour tables, hoisted out of the sweep (`WaterLattice.steps`). */
  private readonly steps: Uint8Array;
  private readonly stepOffsets: Int32Array;
  private readonly stepLengths: Float64Array;

  /** Fields cut short by `maxCells` rather than by range, since the last `reset`. */
  clippedFields = 0;

  /**
   * Swept fields, keyed on start cell, oldest first — `Map` iteration order *is* the LRU order,
   * and a hit re-inserts to move an entry to the back. `null` when caching is off.
   */
  private readonly cache: Map<number, CachedField> | null;
  private readonly cacheBudget: number;
  private cachedCells = 0;

  /** Sweeps served from the cache, and sweeps actually run, since construction. */
  cacheHits = 0;
  cacheMisses = 0;

  constructor(lattice: WaterLattice, options: FieldArenaOptions = {}) {
    this.lattice = lattice;
    this.distance = new Float64Array(lattice.cellCount).fill(Infinity);
    this.touched = new Int32Array(lattice.cellCount);
    this.buckets = new Int32Array(256).fill(-1);
    this.entryCell = new Int32Array(1 << 14);
    this.entryKey = new Float64Array(1 << 14);
    this.entryNext = new Int32Array(1 << 14);
    this.storeCells = new Int32Array(1 << 16);
    this.storeRanges = new Float64Array(1 << 16);
    this.sweepCells = new Int32Array(1 << 14);
    this.sweepRanges = new Float64Array(1 << 14);
    this.steps = lattice.steps;
    this.stepOffsets = lattice.neighbourOffsets();
    this.stepLengths = lattice.neighbourSteps();
    this.cache = options.cache === false ? null : new Map();
    this.cacheBudget = options.cacheCells ?? DEFAULT_CACHE_CELLS;
  }

  /** Drops every field from the previous solve. The buffers — and the cache — stay. */
  reset(): void {
    this.offset = 0;
    this.clippedFields = 0;
  }

  /** Cells the field cache is holding. Zero when caching is off. */
  get cachedFieldCells(): number {
    return this.cachedCells;
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
    if (start < 0) return { offset, count: 0, seed: 0 };

    const centre = this.lattice.centreOf(start);
    const seed = Math.hypot(x - centre.x, y - centre.y);

    // The sweep is sized ignoring the seed, so one cached field answers every position inside the
    // cell rather than only the one that swept it — the seed only ever *shortens* what a request
    // needs, and `emit` trims the tail.
    const grain = this.lattice.cellSize * RADIUS_GRAIN_CELLS;
    const radius = Math.ceil(limits.maxRange / grain) * grain;

    const hit = this.cache?.get(start);
    if (hit !== undefined && hit.radius >= limits.maxRange && hit.maxCells >= limits.maxCells) {
      this.cacheHits += 1;
      // Re-insert to move it to the back of the LRU order.
      this.cache?.delete(start);
      this.cache?.set(start, hit);
      const count = this.emit(offset, hit.cells, hit.ranges, hit.count, seed, limits);
      this.offset = offset + count;
      return { offset, count, seed };
    }

    this.cacheMisses += 1;
    const swept = this.sweep(start, radius, limits.maxCells);
    const cells = this.sweepCells;
    const ranges = this.sweepRanges;
    if (swept.clipped) {
      // A clipped field is a *prefix* of the sweep in bucket order, so it cannot be trimmed to a
      // shorter range and still be what a fresh sweep at that range would have found — it would be
      // short of cells the tighter bound left room for. The guardrail is rare (`clippedFields` is
      // normally zero); not caching it keeps the cache exact instead of nearly exact.
      this.clippedFields += 1;
    } else {
      this.store(start, cells, ranges, swept.count, radius, limits.maxCells);
    }

    const count = this.emit(offset, cells, ranges, swept.count, seed, limits);
    this.offset = offset + count;
    return { offset, count, seed };
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

  /**
   * The path length to the `i`th cell, metres — the stored graph distance plus the handle's seed.
   *
   * The addition happens here, on every read, whether the field was swept this tick or reused from
   * an earlier one. That is the whole of what keeps the cache unobservable; see the file header.
   */
  rangeAt(handle: FieldHandle, i: number): number {
    return handle.seed + (this.storeRanges[handle.offset + i] ?? Infinity);
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  /**
   * Copies a swept field into the arena, dropping whatever the seed has pushed out of range.
   *
   * The stored order is ascending in graph distance to within a cell, so the trimmed tail is the
   * far edge — but it is not a clean prefix, which is why this filters rather than truncating.
   */
  private emit(
    offset: number,
    cells: Int32Array,
    ranges: Float64Array,
    n: number,
    seed: number,
    limits: FieldLimits,
  ): number {
    // Grown once, to the most this can possibly store, rather than tested per cell — the check was
    // costing more than the copy it guarded (planning/16 §3.2, the `shipped` row).
    const cap = Math.min(n, limits.maxCells);
    this.ensureStore(offset + cap);
    const storeCells = this.storeCells;
    const storeRanges = this.storeRanges;
    const maxRange = limits.maxRange;

    let count = 0;
    for (let i = 0; i < n; i += 1) {
      const range = ranges[i]!;
      if (seed + range > maxRange) continue;
      if (count >= cap) break;
      storeCells[offset + count] = cells[i]!;
      storeRanges[offset + count] = range;
      count += 1;
    }
    return count;
  }

  /**
   * One bounded Dijkstra out of `start`, in graph distance — zero at the start cell.
   *
   * Writes into the reusable `sweepCells` / `sweepRanges` scratch and reports how many cells it
   * stored, so a miss allocates only when the cache decides to keep the result.
   */
  private sweep(
    start: number,
    radius: number,
    maxCells: number,
  ): { count: number; clipped: boolean } {
    const cellSize = this.lattice.cellSize;
    const bucketCount = Math.ceil(radius / cellSize) + 2;
    this.prepare(bucketCount);

    this.touchedCount = 0;
    this.mark(start, 0);
    this.push(start, 0, cellSize, bucketCount);

    // Hoisted, and read without `??` below. `noUncheckedIndexedAccess` compiles every typed-array
    // read into a real `undefined` check, and this is the one loop in the codebase where that is
    // measurably expensive — worth 1.3–1.5× on its own (planning/16 §3.3). Every index here is
    // either a cell the lattice sized these arrays for or a bucket/entry this method allocated, so
    // the checks are provably redundant rather than merely believed to be.
    // `entryCell`/`entryKey`/`entryNext` are deliberately *not* hoisted: `push` grows them, so a
    // local would go stale the moment the frontier outgrew its arena. `buckets` is safe because
    // only `prepare` resizes it, and that has already run.
    const { steps, distance, touched, buckets } = this;
    const offsets = this.stepOffsets;
    const lengths = this.stepLengths;
    this.ensureSweep(Math.min(maxCells, this.lattice.cellCount));
    let cells = this.sweepCells;
    let ranges = this.sweepRanges;

    let count = 0;
    let clipped = false;

    sweep: for (let b = 0; b < bucketCount; b += 1) {
      for (let entry = buckets[b]!; entry !== -1; entry = this.entryNext[entry]!) {
        const cell = this.entryCell[entry]!;
        const key = this.entryKey[entry]!;

        // A cell can be queued more than once; only the entry carrying its final distance
        // is the real one.
        if (key > distance[cell]! || key > radius) continue;
        if (count >= maxCells) {
          clipped = true;
          break sweep;
        }

        if (count === cells.length) {
          this.ensureSweep(count + 1);
          cells = this.sweepCells;
          ranges = this.sweepRanges;
        }
        cells[count] = cell;
        ranges[count] = key;
        count += 1;

        // The mask answered bounds, water, and the corner rule when the lattice was built
        // (`WaterLattice.steps`), so what is left of the neighbour loop is the arithmetic.
        let bits = steps[cell]!;
        while (bits !== 0) {
          const lowest = bits & -bits;
          const n = 31 - Math.clz32(lowest);
          bits ^= lowest;

          const next = cell + offsets[n]!;
          const step = key + lengths[n]!;
          if (step > radius || step >= distance[next]!) continue;
          if (distance[next] === Infinity) touched[this.touchedCount++] = next;
          distance[next] = step;
          this.push(next, step, cellSize, bucketCount);
        }
      }
    }

    for (let i = 0; i < this.touchedCount; i += 1) {
      distance[touched[i]!] = Infinity;
    }
    this.touchedCount = 0;

    return { count, clipped };
  }

  /**
   * Files a swept field, evicting least-recently-used entries until it fits.
   *
   * Each entry owns its arrays, so eviction is a delete and the collector does the rest. This is
   * the one place the arena allocates, and it does so on a *miss* — a few times a second across a
   * whole fleet rather than the per-tick megabytes the arena exists to avoid.
   */
  private store(
    start: number,
    cells: Int32Array,
    ranges: Float64Array,
    count: number,
    radius: number,
    maxCells: number,
  ): void {
    const cache = this.cache;
    if (cache === null) return;

    const existing = cache.get(start);
    if (existing !== undefined) {
      this.cachedCells -= existing.count;
      cache.delete(start);
    }

    // A field larger than the whole budget would evict everything and still not fit.
    if (count > this.cacheBudget) return;

    for (const [key, entry] of cache) {
      if (this.cachedCells + count <= this.cacheBudget) break;
      this.cachedCells -= entry.count;
      cache.delete(key);
    }

    cache.set(start, {
      cells: cells.slice(0, count),
      ranges: ranges.slice(0, count),
      count,
      radius,
      maxCells,
    });
    this.cachedCells += count;
  }

  private ensureSweep(needed: number): void {
    if (needed <= this.sweepCells.length) return;
    let size = this.sweepCells.length;
    while (size < needed) size *= 2;
    const cells = new Int32Array(size);
    const ranges = new Float64Array(size);
    cells.set(this.sweepCells);
    ranges.set(this.sweepRanges);
    this.sweepCells = cells;
    this.sweepRanges = ranges;
  }

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
