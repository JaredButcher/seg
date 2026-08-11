/**
 * Ambient ghost returns (planning/15): the squares a boat's own machinery writes on its own
 * picture.
 *
 * The whole module is pure over a seeded `Rng`, so everything here runs a fixed seed and
 * asserts fixed numbers — a replay that haunted different squares would not be a replay
 * (planning/15 §6). The headline property is first: a still, quiet boat produces nothing, and
 * that has to be true over however many solves.
 */

import { describe, expect, it } from 'vitest';

import {
  ACOUSTICS,
  createRng,
  generateGhosts,
  ghostRadiusFor,
  ghostRate,
  visionCellCentre,
  visionGridFor,
  type AcousticTuning,
  type GhostSource,
  type VisionGrid,
} from '../src/index.js';

/** One solve's worth of seconds (`ACOUSTIC_TICK_HZ`). */
const SECONDS = 0.1;
/** Big enough that the full 1000 m halo around `CENTRE` stays inside the grid. */
const grid: VisionGrid = visionGridFor({ width: 4000, height: 4000 });
/** A source here has the whole halo on the grid, so nothing is lost to the edge discard. */
const CENTRE = 2000;

function sourceAt(x: number, y: number, excess: number): GhostSource {
  return { pos: { x, y }, excess };
}

/** How far each ghost's square sits from a source at `CENTRE`. */
function radii(ghosts: readonly { cell: number }[]): number[] {
  return ghosts.map((ghost) => {
    const centre = visionCellCentre(grid, ghost.cell);
    return Math.hypot(centre.x - CENTRE, centre.y - CENTRE);
  });
}

function tuned(patch: Partial<AcousticTuning>): AcousticTuning {
  return { ...ACOUSTICS, ...patch };
}

/** Every ghost over `solves` frames from one source, drawn from a fresh rng per call. */
function collect(
  source: GhostSource,
  solves: number,
  opts: { grid?: VisionGrid; tuning?: AcousticTuning; seed?: number } = {},
): ReturnType<typeof generateGhosts> {
  const rng = createRng(opts.seed ?? 1);
  const out: ReturnType<typeof generateGhosts> = [];
  for (let i = 0; i < solves; i += 1) {
    out.push(...generateGhosts([source], opts.grid ?? grid, rng, SECONDS, opts.tuning));
  }
  return out;
}

describe('ghostRate', () => {
  it('is zero below the noise floor — a still, quiet ship has none', () => {
    // The request's headline property, and it is the *function's* too: at or below the floor
    // the clamp returns exactly zero, so not even a chance draw can fire.
    expect(ghostRate(0)).toBe(0);
    expect(ghostRate(ACOUSTICS.ghostNoiseFloor)).toBe(0);
    expect(ghostRate(-10)).toBe(0);
  });

  it('is monotone non-decreasing in excess', () => {
    const steps = [0, 0.5, 1, 5, 10, 23, 40, 46, 100];
    for (let i = 1; i < steps.length; i += 1) {
      expect(ghostRate(steps[i] ?? 0)).toBeGreaterThanOrEqual(ghostRate(steps[i - 1] ?? 0));
    }
  });

  it('saturates at ghostRateMax from the top of the span onwards', () => {
    const top = ACOUSTICS.ghostNoiseFloor + ACOUSTICS.ghostNoiseSpan;
    expect(ghostRate(top)).toBe(ACOUSTICS.ghostRateMax);
    expect(ghostRate(top + 20)).toBe(ACOUSTICS.ghostRateMax);
    expect(ghostRate(1000)).toBe(ACOUSTICS.ghostRateMax);
  });
});

describe('ghostRadiusFor', () => {
  it('spans exactly the annulus, ends included', () => {
    const halo = tuned({ ghostInnerRadius: 60 });
    expect(ghostRadiusFor(0, halo)).toBeCloseTo(halo.ghostInnerRadius, 6);
    expect(ghostRadiusFor(1, halo)).toBeCloseTo(halo.ghostRadius, 6);
    expect(ghostRadiusFor(0)).toBeCloseTo(0, 6);
    expect(ghostRadiusFor(1)).toBeCloseTo(ACOUSTICS.ghostRadius, 6);
  });

  it('is monotone in the draw, so the inverse CDF really is one', () => {
    let previous = -1;
    for (let u = 0; u <= 1.0001; u += 0.01) {
      const r = ghostRadiusFor(Math.min(1, u));
      expect(r).toBeGreaterThanOrEqual(previous);
      previous = r;
    }
  });

  it('collapses to the uniform-over-area disc at zero falloff', () => {
    // Where the halo started: `radius · sqrt(u)`. Worth pinning because it is the reading that
    // makes the exponent legible — zero means "no falloff", not "some default falloff".
    const flat = tuned({ ghostFalloffExponent: 0 });
    for (const u of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
      expect(ghostRadiusFor(u, flat)).toBeCloseTo(flat.ghostRadius * Math.sqrt(u), 6);
    }
  });

  it('puts the quantiles where the r^-exponent density says they go', () => {
    // With no inner radius the closed form is `r = radius · u^(1/(2 − exponent))`. Checking the
    // quantiles rather than a histogram keeps this a statement about the distribution and not
    // about the rng.
    const power = 1 / (2 - ACOUSTICS.ghostFalloffExponent);
    for (const u of [0.05, 0.25, 0.5, 0.75, 0.99]) {
      expect(ghostRadiusFor(u)).toBeCloseTo(ACOUSTICS.ghostRadius * u ** power, 6);
    }
  });

  it('stays finite at and beyond the exponent where the density has no integral', () => {
    // Two is the singular case and past it the density is not normalisable at all. A tuning pass
    // that overshoots should get a very steep halo, never a NaN cell id on the wire.
    for (const exponent of [1.999, 2, 3, 10]) {
      const steep = tuned({ ghostFalloffExponent: exponent });
      for (const u of [0, 0.5, 1]) {
        const r = ghostRadiusFor(u, steep);
        expect(Number.isFinite(r)).toBe(true);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(steep.ghostRadius);
      }
    }
  });
});

describe('generateGhosts', () => {
  it('emits nothing for a silent source, over a thousand solves', () => {
    const rng = createRng(1);
    for (let i = 0; i < 1000; i += 1) {
      expect(generateGhosts([sourceAt(CENTRE, CENTRE, 0)], grid, rng, SECONDS)).toEqual([]);
    }
  });

  it('does not draw from the rng for a silent source, so the stream is not shifted by silence', () => {
    // A boat that falls silent must not shift the streams of the boats around it — the skip is
    // a function of state (planning/15 §6), and a way to pin that here is that one silent and
    // one loud source draw exactly as the loud one would alone.
    const loud: GhostSource = sourceAt(CENTRE, CENTRE, 60);
    const quiet: GhostSource = sourceAt(CENTRE + 1400, CENTRE + 1400, 0);
    const rngA = createRng(11);
    const rngB = createRng(11);
    // Each call consumes rng state; two fresh streams from the same seed draw identically, so
    // the comparison is the stream, not a position in it.
    const both = generateGhosts([loud, quiet], grid, rngA, SECONDS);
    const only = generateGhosts([loud], grid, rngB, SECONDS);
    expect(both).toEqual(only);
  });

  it('emits at about the max rate over many solves', () => {
    // At flank the per-solve draw is a 0.75 Bernoulli, so 2000 solves is 1500 ghosts expected.
    // The seed is fixed, so the exact count is a constant — the band is just the sanity check.
    const ghosts = collect(sourceAt(CENTRE, CENTRE, 60), 2000);
    const expected = ACOUSTICS.ghostRateMax * SECONDS * 2000;
    expect(ghosts.length).toBeGreaterThanOrEqual(expected * 0.95);
    expect(ghosts.length).toBeLessThanOrEqual(expected * 1.05);
  });

  it('places every ghost within ghostRadius of its source', () => {
    const ghosts = collect(sourceAt(CENTRE, CENTRE, 60), 2000);
    expect(ghosts.length).toBeGreaterThan(0);
    for (const distance of radii(ghosts)) {
      // A cell is a 2 m square, so its centre may sit up to ~1.5 m outside the disc it came from.
      expect(distance).toBeLessThanOrEqual(ACOUSTICS.ghostRadius + 2);
    }
  });

  it('thins with range instead of filling the disc evenly', () => {
    // The property the widened halo exists for. A flat disc would put three quarters of its
    // ghosts in the outer half by area; the falloff has to invert that badly enough that the
    // near field is unmistakably the dense one. Fixed seed, deliberately loose band.
    const ghosts = collect(sourceAt(CENTRE, CENTRE, 60), 4000);
    const half = ACOUSTICS.ghostRadius / 2;
    const inner = radii(ghosts).filter((distance) => distance <= half).length;
    const fraction = inner / ghosts.length;
    expect(fraction).toBeGreaterThan(0.7);
    expect(fraction).toBeLessThan(0.95);
  });

  it('still lands most of its ghosts inside the old 200 m halo, so the near field is unchanged', () => {
    // `ghostRateMax` was raised alongside the radius by exactly this fraction's reciprocal
    // (`content/acoustics.ts`), so the ghosts-per-second a player sees against their own hull is
    // the same as it was before the halo was widened. If this drifts, that pairing is stale.
    const ghosts = collect(sourceAt(CENTRE, CENTRE, 60), 4000);
    const near = radii(ghosts).filter((distance) => distance <= 200).length;
    const fraction = near / ghosts.length;
    const rate = ACOUSTICS.ghostRateMax * fraction;
    expect(rate).toBeGreaterThan(4.5);
    expect(rate).toBeLessThan(5.5);
  });

  it('keeps the inner annulus clear when ghostInnerRadius is non-zero', () => {
    const halo = tuned({ ghostInnerRadius: 40 });
    const ghosts = collect(sourceAt(CENTRE, CENTRE, 60), 2000, { tuning: halo });
    expect(ghosts.length).toBeGreaterThan(0);
    for (const distance of radii(ghosts)) {
      expect(distance).toBeGreaterThanOrEqual(halo.ghostInnerRadius - 2);
    }
  });

  it('keeps every ghost excess below the confirmation threshold', () => {
    const ghosts = collect(sourceAt(CENTRE, CENTRE, 60), 2000);
    expect(ghosts.length).toBeGreaterThan(0);
    for (const ghost of ghosts) {
      expect(ghost.excess).toBeLessThan(ACOUSTICS.confirmationThreshold);
      expect(ghost.excess).toBeGreaterThanOrEqual(0);
    }
  });

  it('discards ghosts that fall outside the grid instead of clamping or wrapping them', () => {
    // A source hard against the map's corner: almost the whole halo is off-grid, and what is
    // kept must still be a real square of that grid — no negative ids, no row-wrap onto the
    // far edge (the `col > 0` bug class in `picture.ts#chart`).
    const small: VisionGrid = visionGridFor({ width: 20, height: 20 });
    const ghosts = collect(sourceAt(1, 1, 60), 2000, { grid: small });
    const total = small.cols * small.rows;
    for (const ghost of ghosts) {
      expect(ghost.cell).toBeGreaterThanOrEqual(0);
      expect(ghost.cell).toBeLessThan(total);
      const centre = visionCellCentre(small, ghost.cell);
      expect(centre.x).toBeGreaterThanOrEqual(0);
      expect(centre.y).toBeGreaterThanOrEqual(0);
      expect(centre.x).toBeLessThan(20);
      expect(centre.y).toBeLessThan(20);
    }
  });

  it('draws the same cells for the same seed and sources, and different cells for another salt', () => {
    const sources = [sourceAt(100, 100, 60), sourceAt(2800, 3200, 60)];
    const rngA = createRng(1234);
    const rngB = createRng(1234);
    const rngC = createRng(1234).fork(7);

    const a = generateGhosts(sources, grid, rngA, SECONDS);
    const b = generateGhosts(sources, grid, rngB, SECONDS);
    expect(a).toEqual(b);

    // A different salt is a different stream, so the haunt is different. Run long enough that
    // the two could not both be empty by luck.
    let aa = a;
    let cc = generateGhosts(sources, grid, rngC, SECONDS);
    for (let i = 0; i < 400; i += 1) {
      aa = [...aa, ...generateGhosts(sources, grid, rngA, SECONDS)];
      cc = [...cc, ...generateGhosts(sources, grid, rngC, SECONDS)];
    }
    expect(cc).not.toEqual(aa);
  });
});
