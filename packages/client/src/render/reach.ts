/**
 * @seg/client/render/reach — the ping-reach rings, over the water and under the fleet.
 *
 * Two circles round every active transducer in the match: what one pulse would show *it*, and how
 * far away the other side would hear that pulse (`@seg/shared/match/reach.ts`). Like the field
 * overlays beside it this draws something the player is not supposed to know — the rings are round
 * both fleets, at true positions — and arrives only for a connection that asked (`seg.reach`).
 *
 * **Not `render/pings.ts`, and the two must not be confused.** That file animates a wavefront
 * leaving a hull the instant it pulses: a beat, over in two thirds of a second, that says *it just
 * went*. These are standing circles that say *this is how far it would get*, they are drawn whether
 * or not anything is pulsing, and they are a measurement rather than a cue. They are told apart on
 * screen the way they are told apart in the code — a pulse ring is a solid stroke that expands and
 * fades, and these are static, dashed, and dimmer.
 *
 * ## Dashes, and why they are drawn in metres
 *
 * A dashed circle reads as an annotation rather than as something in the water, which is exactly
 * what it is. Pixi's graphics have no dash pattern, so a ring is drawn as an arc per dash — and the
 * dash length is a *screen* length converted back into metres, so the pattern stays the same
 * density at every zoom instead of turning into a solid line when the player pulls back.
 *
 * The arc count is capped per ring, so a four-kilometre circle on a zoomed-in scope is coarser
 * rather than unbounded: the number of segments is what this costs, and a debug overlay is not
 * allowed to be the reason a frame is late.
 */

import type { PingReachView, TeamId } from '@seg/shared';
// Type-only: this module never constructs one, and the layer it draws into is owned by
// `ScopeHost`. It also means the arithmetic below is testable without loading a renderer.
import type { Graphics } from 'pixi.js';

import { COLORS } from './palette.js';

/** How long one dash is on screen, pixels. Long enough to read as a dash at any zoom. */
const DASH_PX = 9;
/** And the gap after it. A touch shorter, so the circle still reads as a circle. */
const GAP_PX = 7;
/** The most dashes one ring is drawn with. A cap on work, not a look. */
const MAX_DASHES = 180;
/** The fewest, so a ring seen from very far out is still a ring and not a triangle. */
const MIN_DASHES = 12;

/** The outer ring — what the other side hears. Fainter: it is the bigger, quieter statement. */
const HEARD_ALPHA = 0.34;
/** The inner ring — what the pulse shows its own platform. The reading a tester came for. */
const IMAGING_ALPHA = 0.55;

/**
 * Both rings for every transducer, in one pass.
 *
 * `viewer` is the team whose scope this is, so a player's own transducers are drawn in the fleet
 * colour and everyone else's in the hostile one — the same two-colour rule the rest of the scope
 * uses, so nothing here has to be learned. A spectator (`null`) gets the hostile colour for
 * neither side and the ally colour for both: with no side of their own, "whose is it" is a
 * question the rings are not there to answer.
 *
 * Cleared and redrawn whole, because that is what a frame of this is: the list arrives complete
 * on every view frame and there is nothing on screen worth keeping between two of them.
 */
export function drawReach(
  graphics: Graphics,
  rings: readonly PingReachView[],
  scale: number,
  viewer: TeamId | null,
): void {
  graphics.clear();

  // Widths in metres, like everything else in the world container, so they stay a fixed number of
  // pixels across the zoom range (`drawZones` does the same).
  const hairline = 1.5 / scale;

  for (const ring of rings) {
    const color =
      viewer === null ? COLORS.ally : ring.team === viewer ? COLORS.own : COLORS.hostile;

    if (ring.imaging !== null && ring.imaging > 0) {
      dashedCircle(graphics, ring.pos.x, ring.pos.y, ring.imaging, scale);
      graphics.stroke({ color, width: hairline, alpha: IMAGING_ALPHA });
    }
    if (ring.heard > 0) {
      dashedCircle(graphics, ring.pos.x, ring.pos.y, ring.heard, scale);
      graphics.stroke({ color, width: hairline, alpha: HEARD_ALPHA });
    }
  }
}

/**
 * One dashed circle, as a run of arcs.
 *
 * Each dash opens its own sub-path with a `moveTo`, for the reason `drawZones` explains: `arc` is
 * a path command, so without one the cursor drags a line from wherever it was left — which here
 * would be the previous dash, quietly filling in every gap.
 */
function dashedCircle(
  graphics: Graphics,
  x: number,
  y: number,
  radius: number,
  scale: number,
): void {
  const period = (DASH_PX + GAP_PX) / scale;
  const dashes = Math.max(
    MIN_DASHES,
    Math.min(MAX_DASHES, Math.round((2 * Math.PI * radius) / period)),
  );
  const step = (2 * Math.PI) / dashes;
  // The lit fraction of each step, from the pattern rather than from the count, so a ring that
  // hit either cap has longer or shorter dashes instead of a different-looking circle.
  const lit = step * (DASH_PX / (DASH_PX + GAP_PX));

  for (let i = 0; i < dashes; i += 1) {
    const start = i * step;
    graphics.moveTo(x + radius * Math.cos(start), y + radius * Math.sin(start));
    graphics.arc(x, y, radius, start, start + lit);
  }
}
