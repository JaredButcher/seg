/**
 * The noise a boat's own machinery writes on its own picture — the ghost returns of planning/15.
 *
 * Everything here is a pure function of its inputs and the seeded `Rng`, like the rest of
 * `sim/`. A replay that haunted different squares would not be a replay, so ghosts draw from a
 * stream forked off the map seed (§6) rather than from anything the client could influence.
 *
 * Deliberately **not** in `solve.ts`. The solver is a hot numeric loop with no RNG and no notion
 * of a wall clock; ghosts are a handful of squares per tick attached to a listener, and they do
 * not belong in a pass that walks tens of thousands of cells. Keeping them out also keeps
 * `AcousticSolver.solve` a pure function of its entity list, which several tests depend on.
 *
 * The rate is driven by how much louder a boat is than its own quietest self
 * (`sourceLevelOf(boat) − boat.stats.sourceLevel`), which is zero at all-stop for an undamaged
 * boat above test depth — the request's "a still, quiet ship should have none" falls out of the
 * subtraction rather than a special case. Deliberately not `selfNoiseOf`: that is a pure function
 * of speed and would miss the cavitation cliff, damage, hull groan, and the boat's own
 * transients, all of which should ghost.
 *
 * A ghost is a **square, not a truth**: it is emitted with an excess well below the confirmation
 * threshold, merged into the ordinary picture after selection (`match/vision.ts`), and never run
 * through the confirmation pass — so it can never join a chart or mint a contact.
 */

import { ACOUSTICS, type AcousticTuning } from '../../content/acoustics.js';
import type { Rng } from '../../math/rng.js';
import type { Vec2 } from '../../map/types.js';
import { packVisionCell, VISION_CELL_SIZE, type VisionGrid } from './skin.js';

/** One boat, as a source of ghosts on its own picture. */
export interface GhostSource {
  readonly pos: Vec2;
  /** dB above this boat's own rest level (`sourceLevelOf − stats.sourceLevel`). Zero = silent. */
  readonly excess: number;
}

/** One ghost: a vision square that is only a flicker. */
export interface Ghost {
  /** Packed vision square (`skin.ts#packVisionCell`). */
  readonly cell: number;
  /** Signal excess, dB. Always below `confirmationThreshold`, so it is only ever faint. */
  readonly excess: number;
}

/**
 * Ghosts per second for a boat that loud above its own rest, over the noise floor's span.
 *
 * Linear in decibels, which is already quadratic in speed (`flowNoiseSpan · f²` is); no extra
 * exponent is wanted. Below the floor a boat is genuinely silent and ghosts are exactly zero.
 */
export function ghostRate(excessDb: number, tuning: AcousticTuning = ACOUSTICS): number {
  const t = Math.min(1, Math.max(0, (excessDb - tuning.ghostNoiseFloor) / tuning.ghostNoiseSpan));
  return tuning.ghostRateMax * t;
}

/**
 * The smallest `2 − ghostFalloffExponent` the sampler will work with.
 *
 * At exactly two the density integrates to a logarithm and the disc has no answer at all: every
 * annulus of the same *log* width holds the same number of ghosts, so an inner radius of zero
 * demands infinitely many of them piled at the origin. Clamping there turns a nonsense tuning
 * value into a very steep halo instead of a `NaN` that would reach the wire as a corrupt cell id.
 */
const MIN_RADIAL_POWER = 0.05;

/**
 * Where along the halo a ghost lands, for one uniform draw `u ∈ [0, 1)`.
 *
 * Ghosts thin with range rather than filling the disc evenly — areal density falls as
 * `r^−ghostFalloffExponent` — which is what lets the halo be as wide as an active pulse without
 * becoming a snowstorm. Inverse-CDF of that density over the annulus: writing `p = 2 − exponent`,
 * the fraction of ghosts inside `r` is `(rᵖ − innerᵖ) / (radiusᵖ − innerᵖ)`, so
 *
 * ```
 * r = (innerᵖ + u · (radiusᵖ − innerᵖ))^(1/p)
 * ```
 *
 * At `exponent = 0` this is `p = 2` and the expression collapses to `radius · sqrt(u)` — the
 * ordinary uniform-over-area disc, which is what the halo was before it was widened.
 *
 * Exact over the annulus, where the earlier `inner + (radius − inner)·sqrt(u)` was only exact at
 * `inner = 0`: that form still piled ghosts slightly toward the inner rim of a non-zero halo.
 */
export function ghostRadiusFor(u: number, tuning: AcousticTuning = ACOUSTICS): number {
  const p = Math.max(MIN_RADIAL_POWER, 2 - tuning.ghostFalloffExponent);
  const radius = Math.max(0, tuning.ghostRadius);
  const inner = Math.max(0, Math.min(tuning.ghostInnerRadius, radius)) ** p;
  const outer = radius ** p;
  // Two opposed fractional powers do not round-trip: at a steep exponent `u = 1` comes back a
  // picometre outside the halo. Clamped rather than tolerated, so "within `ghostRadius`" is a
  // promise callers can test against rather than a promise with an epsilon attached.
  return Math.min(radius, (inner + (outer - inner) * u) ** (1 / p));
}

/**
 * Draw one solve's worth of ghosts from a list of sources.
 *
 * `seconds` is the solve interval (`1 / ACOUSTIC_TICK_HZ`), so the rate is sampled as a small
 * Bernoulli per source — `n = floor(λ)` ghosts plus one with probability `λ − n`. The general
 * form is written that way so raising `ghostRateMax` past the current per-solve maximum does not
 * silently clamp to one.
 *
 * Each ghost is placed at a uniform angle and a radius from `ghostRadiusFor`, which thins the
 * halo with range, then snapped to a vision square. A square off the grid is **discarded, not
 * clamped** — clamping would pile ghosts against the map edge and draw a bright line along it for
 * any boat running near the boundary. The discarded draw still consumed its numbers, which is
 * fine: determinism only needs the same state to produce the same stream.
 *
 * The halo now reaches as far as an active pulse, so a boat near the edge of the map discards a
 * large share of its draws. That is the intended shape of the rule rather than waste worth
 * optimising: the alternative is a halo that knows where the map ends, which is a free boundary
 * reveal delivered by the noise system.
 */
export function generateGhosts(
  sources: readonly GhostSource[],
  grid: VisionGrid,
  rng: Rng,
  seconds: number,
  tuning: AcousticTuning = ACOUSTICS,
): Ghost[] {
  const out: Ghost[] = [];
  const { ghostExcessFraction, confirmationThreshold } = tuning;

  for (const source of sources) {
    const rate = ghostRate(source.excess, tuning);
    // No draws at all for a silent boat: the skip is a function of state, so the stream stays
    // a function of state too.
    if (rate <= 0) continue;

    const lambda = rate * seconds;
    let count = Math.floor(lambda);
    if (rng.chance(lambda - count)) count += 1;

    for (let i = 0; i < count; i += 1) {
      const r = ghostRadiusFor(rng.next(), tuning);
      const theta = 2 * Math.PI * rng.next();
      const x = source.pos.x + Math.cos(theta) * r;
      const y = source.pos.y + Math.sin(theta) * r;

      const col = Math.floor(x / VISION_CELL_SIZE);
      const row = Math.floor(y / VISION_CELL_SIZE);
      if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) continue;

      out.push({
        cell: packVisionCell(grid, col, row),
        excess: rng.next() * ghostExcessFraction * confirmationThreshold,
      });
    }
  }

  return out;
}
