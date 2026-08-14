/**
 * @seg/shared/match/field — the acoustic model's own state, as a debug overlay is shown it.
 *
 * The simulation computes a great deal that nothing on the wire has ever carried: the summed
 * power at every point in the water, how far sound had to swim to get there, how loud a thing
 * would have to be for one boat to hear it. A balance question — *why did that boat go undetected
 * at 400 m* — is a question about those numbers, and until this existed the only way to look at
 * one was a breakpoint.
 *
 * This is the shape all of them travel in. Every field here is **a scalar over the water lattice**
 * with a unit and a fixed domain, so one payload, one encoder, one overlay, and one colour key
 * serve all of them — a new field is a `FieldSpec` and a loop that fills an array, not a protocol
 * change. They are **not** part of the sonar picture and never will be: the picture is what a team
 * earned (`match/vision.ts`), and these are ground truth over the whole map for both sides at
 * once, gated on `LobbySettings.debugMode` and on the recipient having asked (`protocol/debug.ts`).
 *
 * ## Absent is a value
 *
 * **Bucket zero means *no reading here*** — rock, water the sweep never reached, a return under
 * the threshold, ambient sea with nothing in it. It is not "a low reading", and the overlay draws
 * it as nothing at all rather than as the bottom of the ramp. Every field has that state and each
 * one decides for itself what produces it: the encoder's only rule is that a non-finite value is
 * absent and everything else clamps into the domain. That is what lets the *same* encoder serve a
 * field where low means "nothing here" (noise) and one where low means "as good as it gets"
 * (minimum detectable level), with no flags.
 *
 * ## The domains are fixed, on purpose
 *
 * Each field's `min` and `max` are constants rather than the frame's own extremes. An
 * auto-scaling ramp would make the same colour mean different things between two frames, which
 * for a *measuring* instrument is a defect: two screenshots of the same fight have to be
 * comparable, and so do the same fight before and after a tuning change.
 *
 * ## A frame is a window, not always an instant
 *
 * Frames go out at `FIELD_MAP_HZ` while the acoustics are solved five times as often, so a field
 * measured at the moment it is packed shows one solve in five and is blind to the other four.
 * That is fine for the fields a developer reads as *terrain* — the water is much the same 100 ms
 * either side — and useless for the ones read to catch an **event**: a pulse rings for six tenths
 * of a second and decays the whole way down, an impact rings from the tick it lands, and either can
 * happen and be gone between two frames. `FieldSpec.window` is which of the two a field is, and a
 * `peak` field's frame stands for everything since the previous frame rather than for the tick it
 * was packed on.
 *
 * ## Three compressions, and why each one is here
 *
 * The lattice is 20 m (`ACOUSTICS.latticeCell`), so a large map is 750 × 300 = 225,000 cells. Sent
 * raw as JSON at the view frame rate that is megabytes a second.
 *
 * - **Downsampled** to at most `MAX_FIELD_SAMPLES` by an integer stride, aggregating each block
 *   the way its field says to (`FieldSpec.aggregate`). Never a mean: every one of these fields is
 *   read to find *where the interesting value is*, and a mean hides a boat by averaging it against
 *   the quiet water in the same block.
 * - **Quantized** into `FIELD_LEVELS` steps across the domain — finer than the colour ramp can
 *   show, and far finer than any judgement made off it.
 * - **Run-length encoded**, which is where most of the saving comes from: away from the handful of
 *   interesting things on the map the whole field is absent, and a run of forty thousand empty
 *   cells costs two numbers.
 */

/** Which field an overlay is asking for. */
export type DebugFieldKind = 'noise' | 'detect' | 'imaging' | 'range';

export const FIELD_KINDS: readonly DebugFieldKind[] = ['noise', 'detect', 'imaging', 'range'];

export function isDebugFieldKind(value: unknown): value is DebugFieldKind {
  return typeof value === 'string' && (FIELD_KINDS as readonly string[]).includes(value);
}

/**
 * What one field is: its name, its unit, the domain its colours span, and how a block of lattice
 * cells collapses into one sample.
 *
 * `aggregate` is *toward the notable reading*, which is not always the larger number. A noise
 * field takes the loudest cell in a block because the question is where the noise is; a minimum
 * detectable level takes the **smallest**, because the question is where detection is possible and
 * the smallest number is the most detectable. Getting this backwards would not look like a bug —
 * it would look like a slightly conservative overlay, which is worse.
 */
export interface FieldSpec {
  readonly kind: DebugFieldKind;
  /** Shown on the colour key. Short: it sits in a 168 px corner readout. */
  readonly label: string;
  readonly unit: string;
  /** The value bucket 1 stands for. Anything under it clamps here. */
  readonly min: number;
  /** The value the top bucket stands for. Anything over it clamps here. */
  readonly max: number;
  readonly aggregate: 'max' | 'min';
  /**
   * The other axis's aggregate: whether a sample is the reading at the instant the frame was
   * packed, or the least favourable one since the previous frame (see the header).
   *
   * `peak` is not free for every field, which is why only the one that needs it has it. Collapsing
   * a window per *cell* means a running accumulator over the whole lattice on every solve — real
   * work on the hot path, for a feature most matches never switch on — whereas `detect` collapses
   * to a single scalar: its shape is the geodesic sweep and everything time-varying in it is one
   * gate, so keeping that gate's peak costs one number a solve. `noise` and `imaging` are just as
   * transient and would want the same treatment the day somebody is willing to pay for it.
   */
  readonly window: 'instant' | 'peak';
  /** One line for the console, when a developer asks what the fields are. */
  readonly summary: string;
}

/**
 * The four fields.
 *
 * Domains chosen against the shipped tables rather than picked to look nice — see each note. They
 * are the one thing here a balance pass may genuinely want to move, and moving one costs nothing
 * downstream: the payload carries its own quantization, so a client decodes whatever it is sent.
 */
export const FIELD_SPECS: Readonly<Record<DebugFieldKind, FieldSpec>> = {
  /**
   * The summed sound power in the water — what lights the walls, and what a listener has to be
   * heard over. Ambient is 0 dB and the loudest continuous source in the game is a
   * super-cavitating weapon at 92 dB, so 2–90 covers everything with the sea itself left dark.
   */
  noise: {
    kind: 'noise',
    label: 'NOISE',
    unit: 'dB',
    min: 2,
    max: 90,
    aggregate: 'max',
    window: 'instant',
    summary: 'sound power in the water — what lights the walls and drowns out returns',
  },
  /**
   * How loud a source would have to be, at each point, for the chosen boat to hear it directly.
   * The classic detection-range prediction, and the reason this whole file exists: the contour
   * where it crosses a hull's rest level *is* that hull's detection range against this listener.
   *
   * 40–120 dB brackets the table from both ends — the quietest hull radiates 41 dB at rest and
   * nothing in the game sustains 120 — so the bottom of the ramp reads "anything at all is
   * audible in here" and the top "nothing that exists is".
   *
   * The one `peak` field, and the reason that idea exists. What this measures moves with the noise
   * at the listener, and most of what moves it is an *event* — somebody pings, a hull hits a wall,
   * a warhead goes off — that is over long before the next frame. Sampled at the instant, the
   * overlay simply never showed those: the deafening a developer went looking for lasted five ticks
   * and the frame was packed on the sixth. Each frame is therefore the **highest** — worst-hearing
   * — reading the window held, so an event between two frames deafens the one that follows it.
   *
   * So its two aggregates point opposite ways — `min` across a block, highest across the window —
   * and that is not a sign error. Both keep the reading that is *worth seeing*: across space that
   * is the pocket where detection is still possible, which a neighbouring dead cell would erase,
   * and across time it is the moment hearing collapsed, which four quiet solves would erase.
   */
  detect: {
    kind: 'detect',
    label: 'MIN AUDIBLE SL',
    unit: 'dB',
    min: 40,
    max: 120,
    aggregate: 'min',
    window: 'peak',
    summary: "how loud a source must be for the selected boat to hear it, at the window's worst",
  },
  /**
   * How far a return from each point would clear the chosen boat's threshold — the *imaging*
   * footprint, as against the hearing one above. Zero is exactly at the threshold, so the edge of
   * the coloured region is the edge of what that boat can see, and everything outside it is water
   * it is lighting too faintly to get an answer back from.
   */
  imaging: {
    kind: 'imaging',
    label: 'IMAGING',
    unit: 'dB',
    min: 0,
    max: 40,
    aggregate: 'max',
    window: 'instant',
    summary: 'signal excess a rock face would return to the selected boat',
  },
  /**
   * Geodesic path length from the chosen boat: how far sound actually has to swim to get there,
   * around headlands and down passages rather than through the rock. The propagation model made
   * visible, and the fastest way to see whether a passage leaks.
   *
   * The domain is `ACOUSTICS.maxRange`, which is where every field stops being followed.
   */
  range: {
    kind: 'range',
    label: 'RANGE',
    unit: 'm',
    min: 0,
    max: 4000,
    aggregate: 'min',
    window: 'instant',
    summary: 'geodesic distance sound travels from the selected boat',
  },
};

/**
 * The most samples one map may be reduced to, before run-length encoding.
 *
 * Sized so the *worst* case is affordable rather than the typical one: a field with a gradient
 * everywhere run-length encodes to nothing, so this is what a pathological frame costs. At 16,384
 * samples that is a JSON array of at most ~33k numbers — tens of kilobytes, twice a second, on a
 * connection that has opted into a debug feature.
 *
 * It also sets the overlay's resolution: a large map lands on 188 × 75, about 80 m per sample.
 * Coarse, and appropriately so — these fields are smooth, and what matters in one is where the
 * gradient is, not what any single cell reads.
 */
export const MAX_FIELD_SAMPLES = 16_384;

/**
 * Values a sample can carry, including the reserved zero.
 *
 * A byte's worth, so the encoder can work in a `Uint8Array` and the numbers stay short on the
 * wire. Bucket 0 is *absent*; 1 through `FIELD_LEVELS` span the domain.
 */
export const FIELD_BUCKETS = 64;

/** How many buckets carry a reading. `FIELD_BUCKETS` less the reserved zero. */
export const FIELD_LEVELS = FIELD_BUCKETS - 1;

/**
 * How often the server sends one, Hz.
 *
 * Deliberately slower than the 10 Hz view frame: a field is read rather than reacted to — nobody
 * dodges a torpedo off one — and the payload is two orders of magnitude larger. Expressed in Hz
 * because the tick rate is the server's number and this file is shared with the decoder.
 */
export const FIELD_MAP_HZ = 2;

/**
 * One frame of one field, packed.
 *
 * Self-describing on purpose — a recipient decodes and *labels* it with nothing but the message in
 * hand, which matters more here than anywhere else in the protocol: this is a debug payload, so
 * its knobs are exactly the ones that get turned mid-investigation. A client built against a
 * hard-coded domain would draw a stale key over a moved ramp and say nothing about it.
 *
 * The grid is anchored at the map origin, `sampleSize` metres apart on both axes, with sample
 * `(col, row)` covering `x ∈ [col·s, (col+1)·s)` and `y ∈ [row·s, (row+1)·s)` in **map** metres —
 * the same y-up frame everything else is drawn in, so row 0 is the seabed edge rather than the top
 * of a screen.
 */
export interface FieldMapView {
  readonly kind: DebugFieldKind;
  /** `FieldSpec.label`, carried so the key names itself. */
  readonly label: string;
  readonly unit: string;
  readonly cols: number;
  readonly rows: number;
  /** Metres per sample, both axes: `latticeCell × stride`. */
  readonly sampleSize: number;
  /** The value bucket 1 stands for. */
  readonly floor: number;
  /** The value one bucket is worth. */
  readonly step: number;
  /**
   * Bucket indices, run-length encoded as `[value, length, value, length, …]`, row-major over
   * `cols × rows` — so the runs cross row boundaries, which is what makes an empty field one run
   * rather than `rows` of them. Zero is *absent*, not a low reading.
   */
  readonly runs: readonly number[];
}

/**
 * The integer stride that brings a grid under `MAX_FIELD_SAMPLES`.
 *
 * Integer, so a sample is a whole number of lattice cells and the block a sample summarizes is the
 * same block at both ends. Derived rather than sent — it is a pure function of the grid, and
 * `sampleSize` is the form a decoder actually needs.
 */
export function fieldSampleStride(cols: number, rows: number): number {
  let stride = 1;
  while (Math.ceil(cols / stride) * Math.ceil(rows / stride) > MAX_FIELD_SAMPLES) stride += 1;
  return stride;
}

/** The value one bucket is worth, for a field's domain. */
export function fieldStepOf(spec: FieldSpec): number {
  return (spec.max - spec.min) / (FIELD_LEVELS - 1);
}

/**
 * A value to a bucket: `0` for absent, otherwise clamped into the domain.
 *
 * Non-finite is absent, and that is the whole of the rule — a producer says "nothing here" by
 * writing `NaN`, so the encoder never has to know what any particular field means by empty.
 */
export function quantizeField(value: number, spec: FieldSpec): number {
  if (!Number.isFinite(value)) return 0;
  const step = fieldStepOf(spec);
  const level = step <= 0 ? 0 : Math.round((value - spec.min) / step);
  return 1 + (level < 0 ? 0 : level > FIELD_LEVELS - 1 ? FIELD_LEVELS - 1 : level);
}

/** And back: the value a bucket stands for under this payload's quantization, or `null` for absent. */
export function fieldValueOf(view: FieldMapView, bucket: number): number | null {
  return bucket <= 0 ? null : view.floor + (bucket - 1) * view.step;
}

/** The domain a payload's ramp spans: what bucket 1 and the top bucket are worth. */
export function fieldDomainOf(view: FieldMapView): { readonly min: number; readonly max: number } {
  return { min: view.floor, max: view.floor + view.step * (FIELD_LEVELS - 1) };
}

/**
 * The values a colour key labels: `count` of them, both ends of the domain included, evenly spaced.
 *
 * The ends are the payload's own bounds rather than round numbers of their own, because a key
 * whose ends did not line up with where the colour stops changing would lie at exactly the two
 * points a reader trusts most.
 */
export function fieldScaleStops(view: FieldMapView, count = 5): number[] {
  const { min, max } = fieldDomainOf(view);
  if (count < 2) return [min];
  const span = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => min + span * i);
}

/**
 * Run-length encode bucket indices: `[value, length, value, length, …]`.
 *
 * No cap on a run's length — the decoder rebuilds against a known sample count, so a run covering
 * the whole map is one pair rather than a lie waiting to be caught.
 */
export function packFieldRuns(values: ArrayLike<number>): number[] {
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
 * Tolerant of a short, long, or malformed run list rather than throwing: this decodes wire data on
 * the display path, and a debug overlay that took the match screen down with it would be a worse
 * bug than whatever it was opened to investigate. A truncated list leaves the tail at zero, which
 * draws as nothing.
 */
export function unpackFieldRuns(runs: readonly number[], count: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, count));
  let at = 0;
  for (let i = 0; i + 1 < runs.length && at < out.length; i += 2) {
    const value = runs[i] ?? 0;
    const length = runs[i + 1] ?? 0;
    if (!Number.isFinite(value) || !Number.isFinite(length) || length <= 0) break;
    const end = Math.min(out.length, at + length);
    out.fill(value < 0 ? 0 : value > FIELD_BUCKETS - 1 ? FIELD_BUCKETS - 1 : value, at, end);
    at = end;
  }
  return out;
}

/** The grid a field was computed on — `WaterLattice`'s shape, without the dependency. */
export interface FieldGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
}

/**
 * One field, packed for the wire.
 *
 * `values` is one entry per lattice cell, row-major, with **`NaN` for no reading**. The caller
 * owns what that means for its field; everything from here down is the same arithmetic whatever it
 * was measuring.
 */
export function packFieldMap(
  spec: FieldSpec,
  grid: FieldGrid,
  values: ArrayLike<number>,
): FieldMapView {
  const { cols, rows, cellSize } = grid;
  const stride = fieldSampleStride(cols, rows);
  const outCols = Math.ceil(cols / stride);
  const outRows = Math.ceil(rows / stride);
  const wantLargest = spec.aggregate === 'max';

  const buckets = new Uint8Array(outCols * outRows);
  for (let row = 0; row < outRows; row += 1) {
    for (let col = 0; col < outCols; col += 1) {
      let best = NaN;
      const rowEnd = Math.min(rows, (row + 1) * stride);
      const colEnd = Math.min(cols, (col + 1) * stride);
      for (let r = row * stride; r < rowEnd; r += 1) {
        for (let c = col * stride; c < colEnd; c += 1) {
          const value = values[r * cols + c] ?? NaN;
          if (!Number.isFinite(value)) continue;
          // A block with any reading in it has one: absence loses to a measurement, always, or a
          // boat sitting one cell off a rock face would be erased by the stone beside it.
          if (!Number.isFinite(best) || (wantLargest ? value > best : value < best)) best = value;
        }
      }
      buckets[row * outCols + col] = quantizeField(best, spec);
    }
  }

  return {
    kind: spec.kind,
    label: spec.label,
    unit: spec.unit,
    cols: outCols,
    rows: outRows,
    sampleSize: cellSize * stride,
    floor: spec.min,
    step: fieldStepOf(spec),
    runs: packFieldRuns(buckets),
  };
}

/** A packed field back to one bucket per entry, row-major. The decoder's whole job. */
export function unpackFieldMap(view: FieldMapView): Uint8Array {
  return unpackFieldRuns(view.runs, view.cols * view.rows);
}
