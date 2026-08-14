/**
 * @seg/client/render/shock — the edge of the scope, when the boat you are commanding is hit.
 *
 * The one thing drawn in this game that is **not a sonar reading**, and it is worth being explicit
 * about why that is allowed here and nowhere else.
 *
 * Every other layer answers "what has the team detected": the chart, the contacts, the launch
 * alarm, even the ping rings are all measurements the acoustic model produced, drawn where it says
 * they are. This is not a measurement. It is the player's own boat reporting damage to its own
 * crew, and there is no detection threshold on knowing you have just been hit — the hull rang, the
 * lights went, and nobody had to confirm a square to find out. So it is drawn in **screen space,
 * around the instrument housing** rather than in the water (`ScopeHost` layer order, 08 §3): it is
 * a fact about the boat, not a fact about a place, and putting it in the world would mean picking
 * a position for something that does not have one.
 *
 * ## Why the edges, specifically
 *
 * Because the middle is where the player is looking, and the middle is already full. A flash over
 * the scope hides the picture at the exact moment the picture matters most, and something drawn on
 * the boat only helps a player whose camera is on the boat — which, in the case this exists for, is
 * precisely the player who did not need telling. The frame is the one region that is always in
 * peripheral vision, always empty, and never carries a reading that could be obscured.
 *
 * The eye is very good at peripheral motion and very bad at peripheral detail, so the shape is
 * chosen for that: a soft inward gradient with no edge to resolve, arriving fast and leaving slow.
 * It reads at the corner of the eye while the player is reading text somewhere else on screen.
 *
 * ## Two severities, and they are not the same event
 *
 * A hit is a **warning** and it decays quickly — it has to be over before the player has finished
 * reacting to it, or a boat taking fire twice in five seconds would leave the screen permanently
 * washed. Losing the boat is a **conclusion**: it lasts more than twice as long, reaches further in
 * from the edge, and is the only one that holds at full strength before it starts to fade, because
 * there is no longer anything the player can do about it and nothing left to obscure.
 *
 * Overlapping flashes take the **strongest**, not the sum. Four warheads inside a second is one
 * event as far as a player's eye is concerned, and summing would make a salvo saturate the screen
 * white while a single fatal hit stayed dim — exactly backwards.
 */

import type { Graphics } from 'pixi.js';

import type { Rect } from './camera.js';
import { COLORS } from './palette.js';

/** Which of the two a flash is. The same pair `audio/transients.ts#HullShockKind` names. */
export type ShockSeverity = 'damage' | 'destroyed';

/** How long a hit's flash lasts, milliseconds. Short — see the header. */
export const SHOCK_MS = 900;

/** And a loss, which is the conclusion rather than the warning. */
export const SHOCK_DESTROYED_MS = 2_200;

/**
 * The fraction of a loss's life spent at full strength before the fade starts.
 *
 * Zero for a hit: a warning that lingers at peak is a warning that obscures the picture the player
 * is trying to act on. A quarter for a loss, because there is nothing left to act on.
 */
const SHOCK_DESTROYED_HOLD = 0.25;

/** How far the glow reaches in from the frame, in CSS pixels, at each severity. */
const SHOCK_DEPTH_PX = 74;
const SHOCK_DESTROYED_DEPTH_PX = 132;

/**
 * How many bands the gradient is drawn as.
 *
 * Pixi has no cheap screen-space gradient fill, so the falloff is quantized into concentric
 * stroked rectangles. Nine is where the banding stops being visible against this palette at this
 * depth — few enough to cost nothing, and the quadratic falloff below does most of the work of
 * hiding the steps anyway.
 */
const SHOCK_BANDS = 9;

/** The brightest the innermost edge of the glow ever gets. */
const SHOCK_ALPHA = 0.5;
const SHOCK_DESTROYED_ALPHA = 0.72;

interface Flash {
  readonly bornAt: number;
  readonly severity: ShockSeverity;
}

/**
 * The damage flashes still burning, and the layer that draws them.
 *
 * Owned by the render loop and driven from the same place the cues are — a hit is a transient on
 * the wire, so the moment it is *heard* is the moment it is drawn (`audio/cues.ts`), and the two
 * surfaces cannot disagree about when it happened.
 *
 * Shaped like `render/pings.ts#HostileAlerts` deliberately: fold in, expire as you draw, expose
 * `active` so the loop can skip the layer entirely on the ninety-nine per cent of frames when
 * nothing is burning. It does *not* share the base class, because that one dedupes by an event's
 * position and tick — the whole point of this one is that it has no position, and the caller has
 * already decided which appearance is the event.
 */
export class HullShock {
  private live: Flash[] = [];

  /** Note a hit on the boat this player is commanding. `now` is the ticker's millisecond clock. */
  hit(severity: ShockSeverity, now: number): void {
    this.live.push({ bornAt: now, severity });
  }

  /** Whether anything is still burning. The loop's guard, and one frame of clearing after. */
  get active(): boolean {
    return this.live.length > 0;
  }

  /**
   * Paint the edge glow for whatever is still alive, and drop whatever is not.
   *
   * Expires as it goes, like the ping rings, so nothing else has to sweep the list — and returns
   * having cleared the layer when the last flash dies, rather than leaving a stale band on screen.
   */
  draw(graphics: Graphics, core: Rect, now: number): void {
    graphics.clear();

    let kept = 0;
    let peak = 0;
    let severity: ShockSeverity = 'damage';

    for (const flash of this.live) {
      const strength = strengthOf(flash, now);
      if (strength <= 0) continue;
      this.live[kept] = flash;
      kept += 1;
      // Strongest wins rather than summing — see the header. A loss outranks a hit at equal
      // strength, because the deeper, longer shape is the one that should be on screen.
      if (strength > peak || (strength === peak && flash.severity === 'destroyed')) {
        peak = strength;
        severity = flash.severity;
      }
    }
    this.live.length = kept;
    if (peak <= 0) return;

    const fatal = severity === 'destroyed';
    const depth = fatal ? SHOCK_DESTROYED_DEPTH_PX : SHOCK_DEPTH_PX;
    const alpha = (fatal ? SHOCK_DESTROYED_ALPHA : SHOCK_ALPHA) * peak;
    const band = depth / SHOCK_BANDS;

    // Outermost band first, so the brightest edge is laid down last and is not dulled by the
    // dimmer ones drawn over it.
    for (let i = SHOCK_BANDS - 1; i >= 0; i -= 1) {
      // Quadratic, so the glow is concentrated hard against the frame and trails off inward
      // rather than reading as a thick uniform border.
      const falloff = (1 - i / SHOCK_BANDS) ** 2;
      const inset = i * band + band / 2;
      graphics.rect(
        core.x + inset,
        core.y + inset,
        Math.max(0, core.width - inset * 2),
        Math.max(0, core.height - inset * 2),
      );
      graphics.stroke({ color: COLORS.hostile, width: band, alpha: alpha * falloff });
    }
  }
}

/** How bright one flash is right now, `0` once it is over. */
function strengthOf(flash: Flash, now: number): number {
  const fatal = flash.severity === 'destroyed';
  const life = (now - flash.bornAt) / (fatal ? SHOCK_DESTROYED_MS : SHOCK_MS);
  if (life < 0 || life >= 1) return 0;

  const hold = fatal ? SHOCK_DESTROYED_HOLD : 0;
  if (life <= hold) return 1;
  return 1 - (life - hold) / (1 - hold);
}
