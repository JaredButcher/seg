/**
 * Three inner loops for the same sweep, timed against each other and checked against the shipped
 * one for exact agreement.
 *
 *   baseline   the `FieldArena` as it is
 *   unguarded  same algorithm, `??` fallbacks dropped from the typed-array reads
 *   masked     an 8-bit traversability mask per cell, precomputed once at match start
 *
 * The point of keeping all three is that they are nested: `masked` contains `unguarded`'s change,
 * so the two numbers separate "what the fallbacks cost" from "what the neighbour tests cost", and
 * planning/16 §3 spends them separately.
 *
 * **Correctness is checked before anything is timed.** A faster sweep that moves a single range by
 * a metre is not a candidate — it is a different game — so the masked variant is compared against
 * the shipped arena cell for cell and range for range, and the script throws rather than reporting
 * a speedup it has not earned.
 *
 *   pnpm bench:acoustics:sweep
 *   MAP=caves SIZE=large pnpm bench:acoustics:sweep
 */

import { ACOUSTICS, FieldArena, WaterLattice } from '@seg/shared';

import { benchMap, optionsFromEnv, spread } from './scenario.js';

const options = optionsFromEnv();
const map = benchMap(options);
const lattice = new WaterLattice(map.extents, map.terrain.obstacles, {
  cellSize: ACOUSTICS.latticeCell,
});
const { cols, rows, cellSize, water } = lattice;

// ── The mask ──────────────────────────────────────────────────────────────────────────
// Bit `n` set means neighbour `n` is a legal step from this cell. Bounds, water, and the
// no-corner-cutting rule are all resolved here, once, instead of eight times per cell per sweep
// for the length of the match.
const DR = [-1, -1, -1, 0, 0, 1, 1, 1] as const;
const DC = [-1, 0, 1, -1, 1, -1, 0, 1] as const;

function buildMask(): Uint8Array {
  const mask = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cell = row * cols + col;
      if (water[cell] !== 1) continue;
      let bits = 0;
      for (let n = 0; n < 8; n += 1) {
        const dr = DR[n] ?? 0;
        const dc = DC[n] ?? 0;
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
        if (water[r * cols + c] !== 1) continue;
        if (dr !== 0 && dc !== 0) {
          if (water[row * cols + c] !== 1 || water[r * cols + col] !== 1) continue;
        }
        bits |= 1 << n;
      }
      mask[cell] = bits;
    }
  }
  return mask;
}

const maskStarted = performance.now();
const MASK = buildMask();
const maskMs = performance.now() - maskStarted;

const OFFSET = new Int32Array(8);
const STEP = new Float64Array(8);
for (let n = 0; n < 8; n += 1) {
  const dr = DR[n] ?? 0;
  const dc = DC[n] ?? 0;
  OFFSET[n] = dr * cols + dc;
  STEP[n] = dr !== 0 && dc !== 0 ? cellSize * Math.SQRT2 : cellSize;
}

// ── The two candidates ────────────────────────────────────────────────────────────────
class Sweeper {
  readonly distance = new Float64Array(cols * rows).fill(Infinity);
  readonly touched = new Int32Array(cols * rows);
  // Sized to the whole lattice rather than to `maxFieldCells`, so the agreement check below can
  // run both sides uncapped without the output being the thing that stops them.
  readonly outCells = new Int32Array(cols * rows);
  readonly outRanges = new Float64Array(cols * rows);
  private buckets = new Int32Array(4096).fill(-1);
  private entryCell = new Int32Array(1 << 18);
  private entryKey = new Float64Array(1 << 18);
  private entryNext = new Int32Array(1 << 18);
  private entryCount = 0;
  private touchedCount = 0;
  /** Queue pressure: every push past the first for a cell is a decrease-key the bucket cannot do. */
  pushes = 0;

  private push(cell: number, key: number, bucketCount: number): void {
    const bucket = Math.min(bucketCount - 1, (key / cellSize) | 0);
    const entry = this.entryCount++;
    this.entryCell[entry] = cell;
    this.entryKey[entry] = key;
    this.entryNext[entry] = this.buckets[bucket] ?? -1;
    this.buckets[bucket] = entry;
    this.pushes += 1;
  }

  private begin(x: number, y: number, maxRange: number): { start: number; buckets: number } {
    const start = lattice.waterIndexAt(x, y);
    const bucketCount = Math.ceil(maxRange / cellSize) + 2;
    this.buckets.fill(-1, 0, bucketCount);
    this.entryCount = 0;
    this.touchedCount = 0;
    if (start < 0) return { start, buckets: bucketCount };

    const col = start % cols;
    const cx = (col + 0.5) * cellSize;
    const cy = ((start - col) / cols + 0.5) * cellSize;
    const seed = Math.hypot(x - cx, y - cy);
    this.distance[start] = seed;
    this.touched[this.touchedCount++] = start;
    this.push(start, seed, bucketCount);
    return { start, buckets: bucketCount };
  }

  private finish(): void {
    for (let i = 0; i < this.touchedCount; i += 1) this.distance[this.touched[i] ?? 0] = Infinity;
    this.touchedCount = 0;
  }

  /** The shipped algorithm with the `??` fallbacks and the per-cell store check removed. */
  unguarded(x: number, y: number, maxRange: number, maxCells: number): number {
    const { start, buckets: bucketCount } = this.begin(x, y, maxRange);
    if (start < 0) return 0;
    const diagonal = cellSize * Math.SQRT2;
    const { distance, entryCell, entryKey, entryNext, buckets, outCells, outRanges } = this;
    let count = 0;

    sweep: for (let b = 0; b < bucketCount; b += 1) {
      for (let entry = buckets[b]!; entry !== -1; entry = entryNext[entry]!) {
        const cell = entryCell[entry]!;
        const key = entryKey[entry]!;
        if (key > distance[cell]! || key > maxRange) continue;
        if (count >= maxCells) break sweep;
        outCells[count] = cell;
        outRanges[count] = key;
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
            if (dr !== 0 && dc !== 0) {
              if (water[row * cols + c] !== 1 || water[r * cols + col] !== 1) continue;
            }
            const step = key + (dr !== 0 && dc !== 0 ? diagonal : cellSize);
            if (step > maxRange || step >= distance[next]!) continue;
            if (distance[next] === Infinity) this.touched[this.touchedCount++] = next;
            distance[next] = step;
            this.push(next, step, bucketCount);
          }
        }
      }
    }
    this.finish();
    return count;
  }

  /** No bounds tests, no water reads, no corner rule — the mask answered all three already. */
  masked(x: number, y: number, maxRange: number, maxCells: number): number {
    const { start, buckets: bucketCount } = this.begin(x, y, maxRange);
    if (start < 0) return 0;
    const { distance, entryCell, entryKey, entryNext, buckets, outCells, outRanges } = this;
    let count = 0;

    sweep: for (let b = 0; b < bucketCount; b += 1) {
      for (let entry = buckets[b]!; entry !== -1; entry = entryNext[entry]!) {
        const cell = entryCell[entry]!;
        const key = entryKey[entry]!;
        if (key > distance[cell]! || key > maxRange) continue;
        if (count >= maxCells) break sweep;
        outCells[count] = cell;
        outRanges[count] = key;
        count += 1;

        let bits = MASK[cell]!;
        while (bits !== 0) {
          const lowest = bits & -bits;
          const n = 31 - Math.clz32(lowest);
          bits ^= lowest;
          const next = cell + OFFSET[n]!;
          const step = key + STEP[n]!;
          if (step > maxRange || step >= distance[next]!) continue;
          if (distance[next] === Infinity) this.touched[this.touchedCount++] = next;
          distance[next] = step;
          this.push(next, step, bucketCount);
        }
      }
    }
    this.finish();
    return count;
  }
}

// ── Agreement, before any timing ──────────────────────────────────────────────────────
const points = spread(lattice, 24);
const arena = new FieldArena(lattice);
const sweeper = new Sweeper();

// Both sides run uncapped. `maxCells` stops the sweep mid-bucket, and *which* cells were stored
// before it bit depends on the order entries come off that bucket — which the header of
// `field.ts` is explicit is unspecified. Comparing across the cap would be testing an order
// neither implementation promises; comparing without it tests the distances, which both do.
const UNCAPPED = 1e9;
for (const p of points) {
  arena.reset();
  const field = arena.solve(p.x, p.y, { maxRange: ACOUSTICS.maxRange, maxCells: UNCAPPED });
  const got = sweeper.masked(p.x, p.y, ACOUSTICS.maxRange, UNCAPPED);
  if (got !== field.count) throw new Error(`cell count ${got} vs ${field.count}`);
  const want = new Map<number, number>();
  for (let i = 0; i < field.count; i += 1) want.set(arena.cellAt(field, i), arena.rangeAt(field, i));
  for (let i = 0; i < got; i += 1) {
    const cell = sweeper.outCells[i] ?? -1;
    const range = want.get(cell);
    if (range === undefined || range !== (sweeper.outRanges[i] ?? NaN)) {
      throw new Error(`range at cell ${cell}: ${sweeper.outRanges[i]} vs ${String(range)}`);
    }
  }
}

console.log(
  `lattice ${cols}x${rows} = ${lattice.cellCount} cells\n` +
    `mask: ${MASK.length} bytes, built in ${maskMs.toFixed(1)} ms — once per match\n` +
    `masked agrees with the shipped arena exactly, over ${points.length} sweeps\n`,
);

// ── Timing ────────────────────────────────────────────────────────────────────────────
function time(label: string, run: (p: { x: number; y: number }) => number): void {
  for (let i = 0; i < 3; i += 1) for (const p of points) run(p);
  sweeper.pushes = 0;
  const runs = 12;
  let cells = 0;
  const started = performance.now();
  for (let i = 0; i < runs; i += 1) for (const p of points) cells += run(p);
  const ms = performance.now() - started;
  const pushes = sweeper.pushes / runs;
  console.log(
    `  ${label.padEnd(10)} ${(ms / runs).toFixed(2).padStart(7)} ms/pass  ` +
      `${((1e6 * ms) / cells).toFixed(1).padStart(6)} ns/cell` +
      (pushes > 0 ? `  ${(pushes / (cells / runs)).toFixed(2)} pushes/cell` : ''),
  );
}

for (const reach of [ACOUSTICS.maxImagingRange, ACOUSTICS.maxRange]) {
  console.log(`reach ${reach} m — ${points.length} sweeps per pass:`);
  time('baseline', (p) => {
    arena.reset();
    return arena.solve(p.x, p.y, { maxRange: reach, maxCells: ACOUSTICS.maxFieldCells }).count;
  });
  time('unguarded', (p) => sweeper.unguarded(p.x, p.y, reach, ACOUSTICS.maxFieldCells));
  time('masked', (p) => sweeper.masked(p.x, p.y, reach, ACOUSTICS.maxFieldCells));
  console.log();
}
