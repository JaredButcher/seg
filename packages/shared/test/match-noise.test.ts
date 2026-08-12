/**
 * The noise heatmap, as the debug overlay receives it (`match/noise.ts`).
 *
 * Two halves, and they fail differently. The **codec** is arithmetic — a run-length round trip
 * and a quantization — and a bug in it is a wrong picture that still draws. The **sampling** is
 * where the payload's whole claim lives: that a grid of a quarter of a million cells can be cut
 * to sixteen thousand samples and still answer the question the overlay exists for, which is
 * "where is the noise". A mean would have failed that, and the test that says so is the one
 * driving a real solve past a loud boat.
 */

import {
  AcousticSolver,
  boatEntity,
  dequantizeNoise,
  getHull,
  MAX_NOISE_SAMPLES,
  NOISE_BUCKETS,
  NOISE_STEP_DB,
  noiseSampleStride,
  packNoiseMap,
  packNoiseRuns,
  quantizeNoise,
  resolveExtents,
  unpackNoiseMap,
  unpackNoiseRuns,
  type BoatState,
  type GeneratedMap,
  type MapExtents,
  type MapSize,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

const EXTENTS: MapExtents = { width: 4000, height: 2000 };
const LEVEL = EXTENTS.height * 0.5;

function world(): GeneratedMap {
  return {
    generatorVersion: 1,
    seed: 1,
    mapType: 'empty',
    mapSize: 'medium',
    extents: EXTENTS,
    depthScale: 1200 / EXTENTS.height,
    terrain: { obstacles: [] },
  };
}

/** One boat at `x`, running at the speed given — the noise this whole payload is about. */
function boat(id: number, x: number, speed: number): BoatState {
  const hull = getHull('medium');
  return {
    id,
    team: 'team1',
    owner: 'p1',
    index: 0,
    name: 'S-01',
    hull: hull.id,
    stats: hull.stats,
    cost: hull.cost,
    pos: { x, y: LEVEL },
    facing: 0,
    speed,
    throttle: 'flank',
    hp: hull.stats.maxHp,
    tubes: [],
    order: { kind: 'hold' },
    status: 'active',
    activeSonar: false,
    lastPingTick: 0,
    transients: [],
  };
}

describe('the run-length codec', () => {
  it('round-trips a field of runs', () => {
    const values = [0, 0, 0, 7, 7, 1, 0, 0];
    const runs = packNoiseRuns(values);

    expect(runs).toEqual([0, 3, 7, 2, 1, 1, 0, 2]);
    expect([...unpackNoiseRuns(runs, values.length)]).toEqual(values);
  });

  it('spends two numbers on a map that is entirely quiet', () => {
    // The saving the payload is built around: away from the handful of noisy things in the
    // water the whole field sits in bucket zero, and that has to cost nothing.
    const runs = packNoiseRuns(new Uint8Array(50_000));
    expect(runs).toEqual([0, 50_000]);
  });

  it('leaves the tail quiet rather than throwing on a malformed run list', () => {
    // Wire data on the display path: a debug overlay that took the match screen down with it
    // would be a worse bug than whatever it was opened to investigate.
    expect([...unpackNoiseRuns([3, 2, 9], 5)]).toEqual([3, 3, 0, 0, 0]);
    expect([...unpackNoiseRuns([3, -1], 3)]).toEqual([0, 0, 0]);
    expect([...unpackNoiseRuns([], 2)]).toEqual([0, 0]);
    // A run past the end is clipped, not written out of bounds.
    expect([...unpackNoiseRuns([1, 99], 2)]).toEqual([1, 1]);
  });

  it('quantizes to the step, and clamps rather than wrapping at both ends', () => {
    expect(dequantizeNoise(quantizeNoise(40))).toBe(40);
    expect(quantizeNoise(-30)).toBe(0);
    // The clamp is the load-bearing half: a value past the top that wrapped would draw the
    // loudest thing on the map as silence.
    expect(quantizeNoise(10_000)).toBe(NOISE_BUCKETS - 1);
    expect(quantizeNoise(Infinity)).toBe(NOISE_BUCKETS - 1);
    expect(quantizeNoise(-Infinity)).toBe(0);
  });
});

describe('the sample grid', () => {
  it('brings every map size under the cap with a whole number of lattice cells', () => {
    for (const size of ['small', 'medium', 'large'] satisfies MapSize[]) {
      const extents = resolveExtents(size);
      const cols = Math.ceil(extents.width / 20);
      const rows = Math.ceil(extents.height / 20);
      const stride = noiseSampleStride(cols, rows);

      expect(Number.isInteger(stride)).toBe(true);
      expect(stride).toBeGreaterThanOrEqual(1);
      expect(Math.ceil(cols / stride) * Math.ceil(rows / stride)).toBeLessThanOrEqual(
        MAX_NOISE_SAMPLES,
      );
    }
  });
});

describe('packing a solve', () => {
  it('describes its own grid, so a decoder needs nothing else', () => {
    const solver = new AcousticSolver(world(), { cellSize: 20 });
    const solution = solver.solve([boatEntity(boat(1, 1000, 0), EXTENTS)]);
    const map = packNoiseMap(solution.noise);

    const stride = noiseSampleStride(solver.lattice.cols, solver.lattice.rows);
    expect(map.cols).toBe(Math.ceil(solver.lattice.cols / stride));
    expect(map.rows).toBe(Math.ceil(solver.lattice.rows / stride));
    expect(map.sampleSize).toBe(20 * stride);
    expect(map.step).toBe(NOISE_STEP_DB);
    expect(unpackNoiseMap(map)).toHaveLength(map.cols * map.rows);
  });

  it('puts the noise where the boat is, and quiet water at the far end of the map', () => {
    const solver = new AcousticSolver(world(), { cellSize: 20 });
    const solution = solver.solve([
      boatEntity(boat(1, 400, getHull('medium').stats.maxSpeed), EXTENTS),
    ]);
    const map = packNoiseMap(solution.noise);
    const samples = unpackNoiseMap(map);

    /** The level at a point on the map, dB, as the payload reports it. */
    const at = (x: number, y: number): number => {
      const col = Math.min(map.cols - 1, Math.floor(x / map.sampleSize));
      const row = Math.min(map.rows - 1, Math.floor(y / map.sampleSize));
      return map.floor + (samples[row * map.cols + col] ?? 0) * map.step;
    };

    // Loud where the boat is, and monotonically quieter away from it — which is the whole of
    // what an overlay reader is looking at.
    expect(at(400, LEVEL)).toBeGreaterThan(40);
    expect(at(1500, LEVEL)).toBeLessThan(at(400, LEVEL));
    expect(at(3800, LEVEL)).toBeLessThan(at(1500, LEVEL));
  });

  it('takes the loudest cell in a block rather than the average', () => {
    // The sampling decision, and the reason it is not a mean: a boat is one lattice cell wide at
    // this stride, so averaging it against the quiet water in the same block would hide exactly
    // the thing the overlay was opened to find. Compared against the lattice's own answer at the
    // boat's cell — the sample must not be quieter than the loudest cell it stands for.
    const solver = new AcousticSolver(world(), { cellSize: 20 });
    const solution = solver.solve([
      boatEntity(boat(1, 400, getHull('medium').stats.maxSpeed), EXTENTS),
    ]);
    const map = packNoiseMap(solution.noise);
    const samples = unpackNoiseMap(map);

    const stride = map.sampleSize / 20;
    const col = Math.floor(400 / map.sampleSize);
    const row = Math.floor(LEVEL / map.sampleSize);
    const sampled = map.floor + (samples[row * map.cols + col] ?? 0) * map.step;

    let loudest = -Infinity;
    for (let r = row * stride; r < (row + 1) * stride && r < solver.lattice.rows; r += 1) {
      for (let c = col * stride; c < (col + 1) * stride && c < solver.lattice.cols; c += 1) {
        loudest = Math.max(loudest, solution.noise.levelAtCell(r * solver.lattice.cols + c));
      }
    }

    // Within one quantization step of the loudest cell, and never under it by more than that.
    expect(sampled).toBeGreaterThanOrEqual(loudest - NOISE_STEP_DB);
  });
});
