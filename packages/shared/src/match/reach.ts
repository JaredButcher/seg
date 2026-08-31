/**
 * @seg/shared/match/reach — how far one active pulse gets, as a debug overlay is shown it.
 *
 * The sibling of `field.ts` and the other half of the same problem. A field answers *what does
 * the water look like right now*; this answers **what would happen if this transducer fired**,
 * which is the question a balance pass about active sonar is actually made of: how much rock does
 * a pulse buy me, and how much of the map does it tell about me. Both are readings the simulation
 * has always had and neither was ever on the wire.
 *
 * ## Two radii, and they are two different physics
 *
 * - **`imaging`** is the pulse's **two-way** reach: out to whatever it is looking for, off it, and
 *   back to the receiver on the platform that fired. The path is paid twice and the reflection is
 *   swallowed once, which is why it lands in the hundreds of metres while the other is in the
 *   thousands. It is the pulse's *own* reading, and **what it is a reading of depends on what is
 *   listening**: a boat or a drone hears through the solve, so its circle is the rock it would
 *   light; a homing torpedo hears through its seeker, which looks for hulls, so its circle is the
 *   range it would acquire one from (`sim/weapons/seeker.ts`).
 * - **`heard`** is the **one-way** reach: how far away the loudest thing on the other side would
 *   still hear the pulse arrive. That one is not about the pinger at all past the source level;
 *   it is about the *listener's* noise floor, and it moves when the other side slows down to
 *   listen as surely as when this boat changes what it is carrying.
 *
 * Both are inverted out of the propagation model rather than measured — `rangeForLoss` is the
 * inverse of `transmissionLoss` and the same one the solver sizes its own sweeps with — so a
 * tuning pass moves the rings and the simulation together, which is the only reason a ring drawn
 * on the scope is worth believing.
 *
 * ## Circles, and what a circle is lying about
 *
 * Sound in this game travels the **geodesic** path (`sim/acoustics/field.ts`): around headlands,
 * down passages, never through rock. A circle is therefore the open-water answer — the radius is
 * right, and the shape is right only where there is nothing in the way. That is a deliberate
 * trade: what a tester needs off this is a *number they can check* against the fleet on screen,
 * and the field overlays already draw the true shape for anyone who needs it (`seg.field`).
 *
 * ## No pulse is required
 *
 * The radii are computed for a pulse fired **now**, whether or not one is due. A transducer that
 * fires every two seconds and rings for four tenths of one is dark for most of the time anybody
 * would be watching it, and rings that appeared for two frames in forty would be unreadable.
 */

import { ACOUSTICS, rangeForLoss, type AcousticTuning } from '../content/acoustics.js';
import type { Vec2 } from '../map/types.js';
import type { EntityId, TeamId } from './world.js';

/**
 * One active transducer's two radii, ground truth, for the debug overlay.
 *
 * `pos` is the true position and is on this payload for the same reason the fields are ground
 * truth over the whole map: the overlay is a *model* view, gated on `LobbySettings.debugMode` and
 * on the recipient having asked for it (`protocol/debug.ts`). A ring drawn only round the pingers
 * a team had already found would answer the one question nobody needs to ask.
 */
export interface PingReachView {
  readonly id: EntityId;
  /** Whose transducer it is, so the overlay can colour it without consulting the view frame. */
  readonly team: TeamId;
  readonly pos: Vec2;
  /**
   * How far this pulse would show its own platform something, metres — rock for a boat or a drone,
   * a hull for a homing torpedo's seeker (see the header).
   *
   * `null` only for a transducer that neither hears through the solve nor homes on what comes
   * back, which nothing in the content table is today. It is kept because the two halves of
   * "carries a transducer" and "listens to it" are separate facts about a load, and a noisemaker
   * that announced itself and heard nothing would be a perfectly sensible thing to add.
   *
   * Zero is a different answer and a real one: a pulse whose echo cannot clear its own receiver's
   * threshold shows its platform nothing at all.
   */
  readonly imaging: number | null;
  /**
   * How far away the keenest hostile listener would hear this pulse, metres. Zero when nobody on
   * the other side could hear it at all — every listener sunk, or a pulse quieter than their
   * floors.
   */
  readonly heard: number;
}

/**
 * The two-way reach of a pulse: out to a reflector, back to the ear that fired it.
 *
 * `sourceLevel` is the level the pulse goes out at, `gate` is the level an echo has to reach for
 * this platform's receiver to call it a contact, and `absorption` is what the reflector swallows
 * on the way past. The budget is what is left of the pulse after the reflection is paid for, and
 * it is split in half because the path is swum twice — which is the whole reason both the imaging
 * picture and a seeker are short-ranged by construction.
 *
 * All three terms are the caller's, and that is the point: this same arithmetic is
 * `solve.ts#look`'s terrain branch with `terrainAbsorption` against a hydrophone's gate, and
 * `seeker.ts#seekerEcho` with a hull's absorption against `seekerThreshold`. Two receivers, two
 * kinds of reflector, one inversion — which is what keeps the ring honest for both of them.
 *
 * Capped at `maxRange`, where every field in the game stops being followed. Deliberately *not*
 * capped at `maxImagingRange`: that number is a floor on how far a listener's own sweep is
 * followed, not a ceiling on what a return can clear, and a platform loud enough to be pulsing is
 * always being swept as a source out to `maxRange` anyway.
 */
export function imagingReach(
  sourceLevel: number,
  gate: number,
  absorption: number,
  tuning: AcousticTuning = ACOUSTICS,
): number {
  const budget = sourceLevel - gate - absorption;
  if (!(budget > 0)) return 0;
  return Math.min(tuning.maxRange, rangeForLoss(budget / 2, tuning));
}

/**
 * The one-way reach of a pulse: how far it is still audible to a listener whose gate is `gate`.
 *
 * The direct-arrival rule of `sim/acoustics/solve.ts#look` rearranged for range instead of for
 * level, so a boat that crosses this circle and pings is a boat the listener hears — which is
 * what makes the ring testable rather than decorative.
 *
 * Zero, not `referenceRange`, when the pulse cannot clear the gate at all: `rangeForLoss` answers
 * a question about *loss* and has no opinion about a sound that was never loud enough, so the
 * "nobody hears this" case is decided here where it means something.
 */
export function heardReach(
  sourceLevel: number,
  gate: number,
  tuning: AcousticTuning = ACOUSTICS,
): number {
  if (!(sourceLevel > gate)) return 0;
  return Math.min(tuning.maxRange, rangeForLoss(sourceLevel - gate, tuning));
}
