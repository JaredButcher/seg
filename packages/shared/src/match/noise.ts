/**
 * @seg/shared/match/noise — the noise heatmap, as a debug client is shown it.
 *
 * `sim/acoustics/solve.ts` builds a `NoiseHeatmap` every solve: the summed power at every water
 * cell, which is simultaneously *what lights the walls* and *what a listener has to be heard
 * over*. It is the single most useful number in the model and the one nothing on the wire has
 * ever carried — a balance question like "why did that boat go undetected at 400 m" is answered
 * by looking at the water around it, and until now the only way to look was a breakpoint.
 *
 * This is that field, quantized and packed for a debug overlay. It is **not** part of the sonar
 * picture and never will be: the picture is what a team *earned* (`match/vision.ts`), and this is
 * ground truth over the whole map for both sides at once. It rides its own message, gated on
 * `LobbySettings.debugMode` and on the recipient having asked for it (`protocol/debug.ts`).
 *
 * ## Three compressions, and why each one is here
 *
 * The lattice is 20 m (`ACOUSTICS.latticeCell`), so a large map is 750 × 300 = 225,000 cells. Sent
 * raw as JSON at the view frame rate that is megabytes a second, which would make the debug tool
 * the most expensive thing in the match by two orders of magnitude.
 *
 * - **Downsampled** to at most `MAX_NOISE_SAMPLES`, by an integer stride, taking the **loudest**
 *   cell in each block. Loudest rather than mean because the question the overlay answers is
 *   "how much noise is there here", and a mean would hide a boat by averaging it against the
 *   quiet water beside it. The stride is derived from the grid alone, so both ends agree without
 *   negotiating.
 * - **Quantized** to `NOISE_STEP_DB` buckets over a fixed floor. Two decibels is finer than the
 *   overlay's colour ramp can show and far finer than any balance judgement made off it.
 * - **Run-length encoded**, which is where most of the saving actually comes from: away from the
 *   handful of noisy things in the water the whole map sits in bucket zero, and a run of forty
 *   thousand quiet cells costs two numbers.
 *
 * ## Rate
 *
 * `NOISE_MAP_HZ` is deliberately slower than the 10 Hz view frame. A heatmap is read rather than
 * reacted to — nobody dodges a torpedo off it — and the payload is orders of magnitude larger
 * than a view frame, so it goes at the slowest rate that still animates.
 */

import { toDecibels } from '../math/decibels.js';
import type { NoiseHeatmap } from '../sim/acoustics/solve.js';

/**
 * The most samples one map may be reduced to, before run-length encoding.
 *
 * Sized so the *worst* case is affordable rather than the typical one: a field with a gradient
 * everywhere run-length encodes to nothing, so this number is what a pathological frame costs.
 * At 16,384 samples that is a JSON array of at most ~33k numbers — tens of kilobytes, a few times
 * a second, on a connection that has already opted into a debug feature.
 *
 * It also sets the overlay's resolution: a large map lands on a 188 × 75 grid, or about 80 m per
 * sample. That is coarse, and appropriately so — the field it is drawing is smooth, and the
 * detail that matters in a heatmap is *where the gradient is*, not what any one cell reads.
 */
export const MAX_NOISE_SAMPLES = 16_384;

/** dB of the lowest bucket. Ambient is 0 dB (`ACOUSTICS.ambientNoise`), and nothing is quieter. */
export const NOISE_FLOOR_DB = 0;

/** dB per bucket. */
export const NOISE_STEP_DB = 2;

/**
 * How many buckets there are, so a value fits a byte with room to spare.
 *
 * 64 buckets of 2 dB is a 126 dB range over the floor, which covers everything the model can
 * produce: the loudest continuous source in the game is a super-cavitating weapon at 92 dB, and a
 * transient power-summed on top of a boat sitting on its own hydrophone does not reach the top of
 * this scale. Anything that did would clamp, and clamping is the right failure — an overlay that
 * wrapped around would draw the loudest thing on the map as silence.
 */
export const NOISE_BUCKETS = 64;

/**
 * How often the server sends one, Hz. See the file header on why it is not the frame rate.
 *
 * Expressed in Hz rather than in ticks because the tick rate is the *server's* number
 * (`SIM_TICK_HZ`, declared at the package root) and this file is imported by the payload's
 * decoder as well as its producer. The publishing loop converts.
 */
export const NOISE_MAP_HZ = 2;

/**
 * One frame of the heatmap, packed.
 *
 * Self-describing on purpose — a recipient decodes it with nothing but the message in hand. It
 * carries its own grid, its own metres-per-sample, and its own quantization, so a client is never
 * decoding against constants it hopes the server was compiled with. That matters more here than
 * elsewhere: this is a debug payload, so it is exactly the sort of thing whose knobs get turned
 * mid-investigation.
 *
 * The grid is anchored at the map origin and `sampleSize` metres apart, both axes, with sample
 * `(col, row)` covering `x ∈ [col·s, (col+1)·s)` and `y ∈ [row·s, (row+1)·s)` in **map** metres —
 * the same y-up frame everything else is drawn in (`map/types.ts`), so row 0 is the seabed edge
 * of the map rather than the top of a screen.
 */
export interface NoiseMapView {
  readonly cols: number;
  readonly rows: number;
  /** Metres per sample, both axes. `latticeCell × stride`. */
  readonly sampleSize: number;
  /** dB of bucket zero. */
  readonly floor: number;
  /** dB per bucket. */
  readonly step: number;
  /**
   * Bucket indices, run-length encoded as `[value, length, value, length, …]`.
   *
   * Row-major over `cols × rows`, so the runs cross row boundaries — which is what makes a quiet
   * map one run rather than `rows` of them.
   */
  readonly runs: readonly number[];
}

/**
 * The integer stride that brings a grid under `MAX_NOISE_SAMPLES`.
 *
 * Integer, so a sample is a whole number of lattice cells and the block a sample summarizes is
 * the same block at both ends. Derived rather than sent — it is a pure function of the grid, and
 * `sampleSize` on the payload is the form a decoder actually needs.
 */
export function noiseSampleStride(cols: number, rows: number): number {
  let stride = 1;
  while (Math.ceil(cols / stride) * Math.ceil(rows / stride) > MAX_NOISE_SAMPLES) stride += 1;
  return stride;
}

/** A level in dB to a bucket index, clamped at both ends. */
export function quantizeNoise(db: number): number {
  if (!Number.isFinite(db)) return db > 0 ? NOISE_BUCKETS - 1 : 0;
  const bucket = Math.round((db - NOISE_FLOOR_DB) / NOISE_STEP_DB);
  return bucket < 0 ? 0 : bucket > NOISE_BUCKETS - 1 ? NOISE_BUCKETS - 1 : bucket;
}

/** And back: the level a bucket stands for, dB. */
export function dequantizeNoise(bucket: number): number {
  return NOISE_FLOOR_DB + bucket * NOISE_STEP_DB;
}

/**
 * Run-length encode bucket indices: `[value, length, value, length, …]`.
 *
 * No cap on a run's length — the decoder rebuilds against a known sample count, so a run that
 * covers the whole map is one pair rather than a lie waiting to be caught.
 */
export function packNoiseRuns(values: ArrayLike<number>): number[] {
  const runs: number[] = [];
  let i = 0;
  while (i < values.length) {
    const value = values[i] ?? 0;
    let length = 1;
    while (i + length < values.length && values[i + length] === value) length += 1;
    runs.push(value, length);
    i += length;
  }
  return runs;
}

/**
 * The inverse, into a buffer of exactly `count` samples.
 *
 * Tolerant of a short, long, or malformed run list rather than throwing: this decodes wire data
 * on the display path, and a debug overlay that took the match screen down with it would be a
 * worse bug than whatever it was opened to investigate. A truncated list leaves the tail at zero,
 * which draws as quiet water.
 */
export function unpackNoiseRuns(runs: readonly number[], count: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, count));
  let at = 0;
  for (let i = 0; i + 1 < runs.length && at < out.length; i += 2) {
    const value = runs[i] ?? 0;
    const length = runs[i + 1] ?? 0;
    if (!Number.isFinite(value) || !Number.isFinite(length) || length <= 0) break;
    const end = Math.min(out.length, at + length);
    out.fill(value < 0 ? 0 : value > NOISE_BUCKETS - 1 ? NOISE_BUCKETS - 1 : value, at, end);
    at = end;
  }
  return out;
}

/**
 * One solve's heatmap, packed for the wire.
 *
 * Reads `levelAt` — the **full** incident energy, what lights the walls and what the water really
 * sounds like — rather than the filtered background a listener competes against. The two differ
 * only where a ping is ringing (`NoiseHeatmap`), and the honest picture of the ocean is the one
 * that includes it: a player looking at this wants to see the pulse they just fired.
 *
 * Called on the publishing path with the heatmap the last solve left behind. That object is
 * rewritten in place by the next solve, so the packing has to happen before the next tick — which
 * it does, because the frame that carries it is built on the tick that produced it.
 */
export function packNoiseMap(noise: NoiseHeatmap): NoiseMapView {
  const { cols, rows, cellSize } = noise.lattice;
  const stride = noiseSampleStride(cols, rows);
  const outCols = Math.ceil(cols / stride);
  const outRows = Math.ceil(rows / stride);

  const buckets = new Uint8Array(outCols * outRows);
  for (let row = 0; row < outRows; row += 1) {
    for (let col = 0; col < outCols; col += 1) {
      // The loudest cell in the block, so a boat is never averaged into the water beside it —
      // compared as **power**, with the one logarithm paid per sample rather than per cell. This
      // sweeps every lattice cell on the map, so that is the difference between a couple of
      // milliseconds and thirty of them on the tick that publishes (`NoiseHeatmap.powerAtCell`).
      let loudest = 0;
      const rowEnd = Math.min(rows, (row + 1) * stride);
      const colEnd = Math.min(cols, (col + 1) * stride);
      for (let r = row * stride; r < rowEnd; r += 1) {
        for (let c = col * stride; c < colEnd; c += 1) {
          const power = noise.powerAtCell(r * cols + c);
          if (power > loudest) loudest = power;
        }
      }
      buckets[row * outCols + col] = quantizeNoise(toDecibels(loudest));
    }
  }

  return {
    cols: outCols,
    rows: outRows,
    sampleSize: cellSize * stride,
    floor: NOISE_FLOOR_DB,
    step: NOISE_STEP_DB,
    runs: packNoiseRuns(buckets),
  };
}

/** A packed map back to one sample per entry, row-major. The decoder's whole job. */
export function unpackNoiseMap(view: NoiseMapView): Uint8Array {
  return unpackNoiseRuns(view.runs, view.cols * view.rows);
}

/** The level a decoded bucket stands for under *this* payload's quantization, dB. */
export function noiseLevelOf(view: NoiseMapView, bucket: number): number {
  return view.floor + bucket * view.step;
}
