/**
 * Seeing through an active decoy — the one thing that beats it, and what it costs to try.
 *
 * A decoy is not a trick played on the display. It reaches the acoustic solve as the boat that
 * fired it, with that boat's silhouette and that boat's noise
 * (`sim/acoustics/torpedoes.ts`), so a team that confirms one has confirmed a submarine by
 * exactly the rules that confirm submarines. Nothing in the picture is lying, and there is
 * therefore nothing in the picture to see through.
 *
 * What gives it away is **size**, and only an active pulse can measure size. A hundred metres of
 * pressure hull and seven metres of decoy return the same *bearing* and, at the levels this model
 * works in, similar enough passive noise to be the same contact — but they do not return the same
 * echo. So the counter to a decoy is the loudest thing a player can do, and the counter costs
 * exactly what pinging always costs: everyone now knows where the listener is (planning/03 §3).
 * A decoy that could be doubted for free would not be worth fifteen points.
 *
 * ## Why the arithmetic is here and not in the solver
 *
 * The same reason `seeker.ts` gives, and the same mitigation. The solve sums *power at a point*;
 * it has no notion of which source lit a given square, so it cannot answer "did **my** pulse come
 * back off that". Answering it needs a two-way path from one named pinging boat to one named
 * reflector, which is what this file is — built out of `seekerEcho`, `returnThreshold` and
 * `clearWater`, the functions the ocean itself uses, so a tuning pass on `content/acoustics.ts`
 * moves the reveal range with everything else.
 *
 * ## And why the noise floor is the listener's own
 *
 * `noiseFloorOf(-Infinity, …)`: the boat hears its own machinery and nothing else. It is the
 * simplification `seekerThreshold` makes, and here it errs the same way — a boat in a noisy
 * corner of the map is not made *worse* at classifying by the racket around it, so the range at
 * which a pulse strips a decoy is a number the player can learn rather than one that moves with
 * the traffic. Erring the other way would produce the memorable injustice: a ping that revealed
 * the decoy last time and does not now.
 */

import {
  noiseFloorOf,
  returnThreshold,
  selfNoiseOf,
  type AcousticTuning,
} from '../../content/acoustics.js';
import type { TorpedoState } from '../../match/torpedo.js';
import type { BoatState } from '../../match/world.js';
import type { TerrainCollider } from '../collision/terrain.js';
import { clearWater, seekerEcho } from './seeker.js';

/**
 * Whether one boat's active pulse comes back off `decoy` strongly enough to measure it — at which
 * point that team knows the contact is seven metres of torpedo rather than the submarine it
 * sounds like.
 *
 * **The caller owns "did this boat actually pulse".** That is a fact about the tick, and the
 * runtime already knows it from `lastPingTick` (`server/match/runtime.ts`); asking it twice is
 * how a reveal comes to happen on a pulse that never fired. What is owned here is the *level*:
 * out to the decoy, off the hull it is pretending to be, and back.
 *
 * Note which absorption is used — the **mimicked** hull's. A decoy imitating an anechoically
 * coated boat is a quieter reflector, so it has to be pinged from closer to be caught out. That
 * falls out of the mimicry rather than being a rule about decoys, which is the right place for
 * it: fitting a coating makes your decoys better too.
 */
export function decoyRevealedBy(
  boat: BoatState,
  decoy: TorpedoState,
  terrain: TerrainCollider | null,
  tuning?: AcousticTuning,
): boolean {
  if (decoy.mimic === null || decoy.phase === 'spent') return false;
  if (boat.status === 'destroyed' || !boat.activeSonar) return false;

  const range = Math.hypot(decoy.pos.x - boat.pos.x, decoy.pos.y - boat.pos.y);
  const echo = seekerEcho(boat.stats.pingLevel, range, decoy.mimic.stats, tuning);
  if (echo < classificationThreshold(boat, tuning)) return false;

  // The expensive test last, and only for a decoy that would otherwise have been measured. A
  // pulse cannot classify round a corner any more than it can detect round one.
  return terrain === null || clearWater(terrain, boat.pos, decoy.pos);
}

/**
 * The level an echo has to reach for this boat to be able to say how big the thing was.
 *
 * The same threshold detection uses, and that is a deliberate choice rather than a missing
 * feature: a separate, higher "classification" bar would be a second number to balance and would
 * mean a range band where a player can see a return, cannot classify it, and is told nothing
 * about which of the two situations they are in. One threshold gives the honest rule — if your
 * pulse reaches it, you know what it is.
 */
export function classificationThreshold(boat: BoatState, tuning?: AcousticTuning): number {
  const floor = noiseFloorOf(-Infinity, selfNoiseOf(boat.stats, boat.speed, tuning), tuning);
  return returnThreshold(floor, boat.stats.arrayGain, tuning);
}
