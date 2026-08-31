/**
 * The debug field payload (`match/field.ts`) — the codec, not the physics.
 *
 * What the four fields actually measure is proved against a running match in the server's
 * `match-fields` suite, where there is water to measure. This is the layer under that: a
 * run-length round trip, a quantization with a reserved *absent*, and the block aggregation that
 * carries the payload's whole claim — that a grid of a quarter of a million cells can be cut to
 * sixteen thousand samples and still answer the question the overlay exists for.
 */

import {
  fieldDomainOf,
  fieldScaleStops,
  fieldStepOf,
  fieldValueOf,
  isDebugFieldKind,
  packFieldMap,
  packFieldRuns,
  quantizeField,
  unpackFieldMap,
  unpackFieldRuns,
  FIELD_BUCKETS,
  FIELD_KINDS,
  FIELD_LEVELS,
  FIELD_SPECS,
  MAX_FIELD_SAMPLES,
  fieldSampleStride,
  resolveExtents,
  type FieldGrid,
  type MapSize,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

const NOISE = FIELD_SPECS.noise;
const RANGE = FIELD_SPECS.range;

/** A lattice-shaped grid, at the shipped 20 m spacing. */
function grid(cols: number, rows: number): FieldGrid {
  return { cols, rows, cellSize: 20 };
}

/** One field's worth of cell values, `NaN` where there is no reading. */
function cells(values: readonly number[]): Float64Array {
  return Float64Array.from(values);
}

describe('the run-length codec', () => {
  it('round-trips a field of runs', () => {
    const values = [0, 0, 0, 7, 7, 1, 0, 0];
    const runs = packFieldRuns(values);

    expect(runs).toEqual([0, 3, 7, 2, 1, 1, 0, 2]);
    expect([...unpackFieldRuns(runs, values.length)]).toEqual(values);
  });

  it('spends two numbers on a field that is entirely absent', () => {
    // The saving the payload is built around: away from the handful of interesting things on the
    // map the whole field is bucket zero, and that has to cost nothing.
    expect(packFieldRuns(new Uint8Array(50_000))).toEqual([0, 50_000]);
  });

  it('leaves the tail absent rather than throwing on a malformed run list', () => {
    // Wire data on the display path: a debug overlay that took the match screen down with it
    // would be a worse bug than whatever it was opened to investigate.
    expect([...unpackFieldRuns([3, 2, 9], 5)]).toEqual([3, 3, 0, 0, 0]);
    expect([...unpackFieldRuns([3, -1], 3)]).toEqual([0, 0, 0]);
    expect([...unpackFieldRuns([], 2)]).toEqual([0, 0]);
    // A run past the end is clipped, not written out of bounds.
    expect([...unpackFieldRuns([1, 99], 2)]).toEqual([1, 1]);
  });
});

describe('quantization', () => {
  it('reserves bucket zero for no reading at all', () => {
    // The rule that lets one encoder serve a field where low means "nothing here" and one where
    // low means "as good as it gets": absence is the producer's `NaN`, never a low value.
    expect(quantizeField(NaN, NOISE)).toBe(0);
    expect(quantizeField(Infinity, NOISE)).toBe(0);
    expect(quantizeField(NOISE.min, NOISE)).toBe(1);
  });

  it('clamps a value past either end instead of wrapping', () => {
    // A value past the top that wrapped would draw the loudest thing on the map as the quietest.
    expect(quantizeField(NOISE.min - 500, NOISE)).toBe(1);
    expect(quantizeField(NOISE.max + 500, NOISE)).toBe(FIELD_LEVELS);
    expect(FIELD_LEVELS).toBeLessThan(FIELD_BUCKETS);
  });

  it('round-trips a value to within half a step', () => {
    // Half a bucket is the whole of the loss, and at 1.4 dB a bucket that is finer than the
    // colour ramp can show — which is what makes the quantization free rather than a compromise.
    const step = fieldStepOf(NOISE);
    for (const value of [NOISE.min, 40, 61.5, NOISE.max]) {
      const view = packFieldMap(NOISE, grid(1, 1), cells([value]));
      const back = fieldValueOf(view, unpackFieldMap(view)[0] ?? 0);
      expect(back).not.toBeNull();
      expect(Math.abs((back ?? 0) - value)).toBeLessThanOrEqual(step / 2 + 1e-9);
    }
  });
});

describe('the colour key’s numbers', () => {
  it('spans the payload’s own domain, ends included, evenly spaced', () => {
    const view = packFieldMap(NOISE, grid(1, 1), cells([NaN]));
    const stops = fieldScaleStops(view);
    const domain = fieldDomainOf(view);

    expect(stops).toHaveLength(5);
    expect(stops[0]).toBe(domain.min);
    expect(stops[4]).toBe(domain.max);
    expect(domain.min).toBe(NOISE.min);
    expect(domain.max).toBeCloseTo(NOISE.max, 9);

    const steps = stops.slice(1).map((value, i) => value - (stops[i] ?? 0));
    for (const step of steps) expect(step).toBeCloseTo(steps[0] ?? 0, 9);
  });

  it('lands on whole units for every field that ships', () => {
    // Not decoration: a key a developer has to read off a fraction is a worse key, and the
    // domains in `FIELD_SPECS` are chosen so that five stops come out whole. This is the test
    // that says so, so a domain moved for balance reasons cannot quietly spoil it.
    for (const kind of FIELD_KINDS) {
      const view = packFieldMap(FIELD_SPECS[kind], grid(1, 1), cells([NaN]));
      for (const stop of fieldScaleStops(view)) {
        expect(Number.isInteger(Math.round(stop * 1e6) / 1e6)).toBe(true);
      }
    }
  });

  it('has no value for an absent bucket', () => {
    const view = packFieldMap(NOISE, grid(1, 1), cells([NaN]));
    expect(fieldValueOf(view, 0)).toBeNull();
  });
});

describe('the sample grid', () => {
  it('brings every map size under the cap with a whole number of lattice cells', () => {
    for (const size of ['small', 'medium', 'large'] satisfies MapSize[]) {
      const extents = resolveExtents(size);
      const cols = Math.ceil(extents.width / 20);
      const rows = Math.ceil(extents.height / 20);
      const stride = fieldSampleStride(cols, rows);

      expect(Number.isInteger(stride)).toBe(true);
      expect(stride).toBeGreaterThanOrEqual(1);
      expect(Math.ceil(cols / stride) * Math.ceil(rows / stride)).toBeLessThanOrEqual(
        MAX_FIELD_SAMPLES,
      );
    }
  });

  it('describes its own grid, so a decoder needs nothing else', () => {
    const view = packFieldMap(NOISE, grid(4, 2), cells([NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN]));

    expect(view.kind).toBe('noise');
    expect(view.label).toBe(NOISE.label);
    expect(view.unit).toBe(NOISE.unit);
    expect(view.cols).toBe(4);
    expect(view.rows).toBe(2);
    expect(view.sampleSize).toBe(20);
    expect(view.floor).toBe(NOISE.min);
    expect(unpackFieldMap(view)).toHaveLength(8);
  });
});

describe('aggregating a block', () => {
  /** A 2 × 2 lattice reduced to one sample, which is the stride-2 case in miniature. */
  function oneSample(spec: typeof NOISE, values: readonly number[]): number | null {
    // 256 × 256 is four times the sample cap, so the stride is exactly two and one sample covers
    // exactly the four cells below.
    const wide = 256;
    const filled = new Float64Array(wide * wide).fill(NaN);
    // Four cells in the top-left corner, so a stride of 1 would keep them apart.
    filled[0] = values[0] ?? NaN;
    filled[1] = values[1] ?? NaN;
    filled[wide] = values[2] ?? NaN;
    filled[wide + 1] = values[3] ?? NaN;
    // Force a stride by asking for a grid far past the sample cap.
    const view = packFieldMap(spec, { cols: wide, rows: wide, cellSize: 20 }, filled);
    expect(view.sampleSize).toBeGreaterThan(20);
    return fieldValueOf(view, unpackFieldMap(view)[0] ?? 0);
  }

  /** Within one quantization step, which is as close as any value survives the wire. */
  function expectNear(actual: number | null, expected: number, spec: typeof NOISE): void {
    expect(actual).not.toBeNull();
    expect(Math.abs((actual ?? 0) - expected)).toBeLessThanOrEqual(fieldStepOf(spec));
  }

  it('takes the loudest cell for a field read for where the signal is', () => {
    // Never a mean: a boat is one lattice cell wide at these strides, so averaging it against the
    // quiet water in the same block would hide exactly what the overlay was opened to find.
    expectNear(oneSample(NOISE, [10, 70, 12, 8]), 70, NOISE);
  });

  it('takes the smallest cell for a field where small is the notable reading', () => {
    // `range` and `detect` are read for where a thing is *nearest* and *most audible*. Aggregating
    // toward the larger number would draw a slightly conservative overlay, which is worse than an
    // obviously broken one because nobody would notice.
    expect(RANGE.aggregate).toBe('min');
    expectNear(oneSample(RANGE, [900, 300, 1200, 800]), 300, RANGE);
  });

  it('lets any reading beat an absent one', () => {
    // A boat sitting one cell off a rock face must not be erased by the stone beside it.
    expectNear(oneSample(NOISE, [NaN, NaN, 55, NaN]), 55, NOISE);
    expect(oneSample(NOISE, [NaN, NaN, NaN, NaN])).toBeNull();
  });
});

describe('the field roster', () => {
  it('names every kind it ships, and rejects anything else', () => {
    for (const kind of FIELD_KINDS) {
      expect(isDebugFieldKind(kind)).toBe(true);
      expect(FIELD_SPECS[kind].kind).toBe(kind);
      expect(FIELD_SPECS[kind].max).toBeGreaterThan(FIELD_SPECS[kind].min);
    }
    // The wire check: a crafted `debug.setField` must not index the spec table with anything.
    expect(isDebugFieldKind('temperature')).toBe(false);
    expect(isDebugFieldKind(null)).toBe(false);
    expect(isDebugFieldKind(7)).toBe(false);
  });
});
