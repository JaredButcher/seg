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
 * Draw one solve's worth of ghosts from a list of sources.
 *
 * `seconds` is the solve interval (`1 / ACOUSTIC_TICK_HZ`), so the rate is sampled as a small
 * Bernoulli per source — `n = floor(λ)` ghosts plus one with probability `λ − n`. The general
 * form is written that way so raising `ghostRateMax` past the current per-solve maximum does not
 * silently clamp to one.
 *
 * Each ghost is placed uniformly over the *area* of the annulus around its source (`sqrt(u)`
 * for the radius, a uniform angle), then snapped to a vision square. A square off the grid is
 * **discarded, not clamped** — clamping would pile ghosts against the map edge and draw a bright
 * line along it for any boat running near the boundary. The discarded draw still consumed its
 * numbers, which is fine: determinism only needs the same state to produce the same stream.
 */
export function generateGhosts(
  sources: readonly GhostSource[],
  grid: VisionGrid,
  rng: Rng,
  seconds: number,
  tuning: AcousticTuning = ACOUSTICS,
): Ghost[] {
  const out: Ghost[] = [];
  const { ghostRadius, ghostInnerRadius, ghostExcessFraction, confirmationThreshold } = tuning;

  for (const source of sources) {
    const rate = ghostRate(source.excess, tuning);
    // No draws at all for a silent boat: the skip is a function of state, so the stream stays
    // a function of state too.
    if (rate <= 0) continue;

    const lambda = rate * seconds;
    let count = Math.floor(lambda);
    if (rng.chance(lambda - count)) count += 1;

    for (let i = 0; i < count; i += 1) {
      const r = ghostInnerRadius + (ghostRadius - ghostInnerRadius) * Math.sqrt(rng.next());
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
