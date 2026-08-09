/**
 * The torpedo seeker — a very small, very deaf active sonar bolted to a warhead.
 *
 * planning/04 §1 step 9 puts the seeker after the tracker and says it "consumes the same
 * detection output" as a boat. **This does not do that, and the reason is worth stating rather
 * than hiding**, because it is the one place the weapons system departs from the design.
 *
 * Two things stand in the way of routing a seeker through `sim/acoustics/solve.ts`:
 *
 * 1. **Vision there is pooled per team** (C17, `match/vision.ts`). A torpedo added to the solve
 *    as a listener would hand its whole picture to the team that fired it — every wall and every
 *    hull it lit would appear on their scope. That turns a weapon into a free forward sensor and
 *    quietly deletes the reason to carry the sonar drone the content table already has.
 * 2. **The rates do not line up.** Fuzing runs at 20 Hz because torpedo terminal geometry is
 *    what forced 20 Hz in the first place (planning/04 §1), and the solve runs at 10. A seeker
 *    reading a solve would act on a picture up to a tick and a half old, at 55 m/s.
 *
 * So the seeker is its own thing, and what makes that safe is that it is built out of the
 * **same acoustic primitives** rather than out of its own arithmetic: `transmissionLoss`,
 * `hullMaterial`, `noiseFloorOf`, and `returnThreshold` are the functions the ocean uses, read
 * from the same table. A tuning pass on `content/acoustics.ts` moves the seeker with everything
 * else, which is the property that actually matters.
 *
 * What it gives up is geodesic propagation: range here is a straight line rather than the
 * shortest path *through water*. In exchange it gets an explicit line-of-sight test against the
 * rock mask, so a weapon still cannot hear round a corner — it simply cannot hear *along* one
 * either, which for a three-hundred-metre seeker is a difference that rarely comes up.
 *
 * ## It is deaf on purpose
 *
 * `seekerPingLevel` is 95 dB where a boat's is 108–124, and `SEEKER_SELF_NOISE` is 20 dB where a
 * stopped submarine's is −6. Together those put acquisition at roughly 340 m against a bare
 * hull, and an anechoic coating takes a further bite. That number *is* the mechanic the brief
 * asks for: the enable point has to be put in front of where the target will be, close enough
 * that it is inside this when the sonar wakes up. A generous seeker would make the aim point
 * decoration.
 */

import {
  hullMaterial,
  noiseFloorOf,
  returnThreshold,
  transmissionLoss,
  type AcousticTuning,
} from '../../content/acoustics.js';
import type { Stats } from '../../content/stats.js';
import { SEEKER_ARC, SEEKER_GAIN, SEEKER_SELF_NOISE, getWeapon } from '../../content/weapons.js';
import type { Vec2 } from '../../map/types.js';
import type { TorpedoState } from '../../match/torpedo.js';
import type { BoatState } from '../../match/world.js';
import type { TerrainCollider } from '../collision/terrain.js';

/** What a seeker heard: a position, and how far its echo cleared the threshold. */
export interface SeekerReturn {
  readonly at: Vec2;
  readonly excess: number;
}

/**
 * The level a seeker's own pulse comes back at, off a hull `range` metres away.
 *
 * The path is paid **twice** — out to the hull and back again — which is why a seeker's reach is
 * so much shorter than the range at which the same weapon can be *heard*. That asymmetry is the
 * same one active sonar has on a boat (planning/03 §9.2), reproduced here for free by having the
 * arithmetic be the same arithmetic.
 *
 * Takes the stat block rather than the boat, because what a reflection is made of is the hull's
 * material and nothing else — and because the thing reflecting may not be a boat at all
 * (`seekerLook`).
 */
export function seekerEcho(
  pingLevel: number,
  range: number,
  stats: Stats,
  tuning?: AcousticTuning,
): number {
  const loss = transmissionLoss(range, tuning);
  return pingLevel - loss - hullMaterial(stats, tuning).absorption - loss;
}

/**
 * The level an echo has to reach for this seeker to call it a contact.
 *
 * Constant for the whole match — a torpedo's noise floor is its own machinery and nothing else,
 * because the model has no heatmap reading at the weapon's position here. That is a real
 * simplification and it errs the *right* way: the seeker never gets quieter than this, so a
 * noisy corner of the map cannot make a weapon deafer than the number above promises.
 */
export function seekerThreshold(tuning?: AcousticTuning): number {
  return returnThreshold(noiseFloorOf(-Infinity, SEEKER_SELF_NOISE, tuning), SEEKER_GAIN, tuning);
}

/**
 * What one pulse from this weapon hears, or `null` for a pulse into an empty ocean.
 *
 * **Every boat is a candidate, including the firer's own team and the boat that fired it.**
 * Friendly fire is on (Q7) and it is on here rather than in a check the caller could forget: a
 * seeker that filtered by team would be a seeker that cannot be walked into a teammate, and
 * planning/04 §7 wants exactly that failure to be possible and memorable.
 *
 * **So is every active decoy in the water**, and for the same reason one step further on. The
 * file this seeker is written against says a weapon that held an entity id would be a weapon
 * that cannot be decoyed; this is that promise being kept. A decoy reflects the launching boat's
 * silhouette with the launching boat's absorption (`match/torpedo.ts#DecoyMimic`), so it is
 * heard *as* that boat and the seeker has no way to tell — which is the whole of what a decoy
 * is bought for. Nothing in here knows it is looking at one.
 *
 * Loudest wins. A weapon between two hulls goes for the one it hears best, which is usually the
 * nearer and always the one an observer would have predicted.
 */
export function seekerLook(
  torpedo: TorpedoState,
  boats: readonly BoatState[],
  decoys: readonly TorpedoState[],
  terrain: TerrainCollider | null,
  tuning?: AcousticTuning,
): SeekerReturn | null {
  const def = getWeapon(torpedo.weapon);
  if (def.seekerPingLevel <= 0) return null;

  const gate = seekerThreshold(tuning);
  let best: SeekerReturn | null = null;

  /** One candidate reflector, whatever it is bolted to. Loudest-wins, line of sight last. */
  const consider = (at: Vec2, stats: Stats): void => {
    const dx = at.x - torpedo.pos.x;
    const dy = at.y - torpedo.pos.y;
    const range = Math.hypot(dx, dy);
    // Inside its own length is not a detection, it is a hit — and the fuze has already had it.
    if (range <= 0) return;
    if (!inSeekerArc(torpedo.facing, dx, dy)) return;

    const excess = seekerEcho(def.seekerPingLevel, range, stats, tuning) - gate;
    if (excess < 0) return;
    if (best !== null && excess <= best.excess) return;
    // The expensive test last, and only for a hull that would otherwise be heard.
    if (terrain !== null && !clearWater(terrain, torpedo.pos, at)) return;

    best = { at, excess };
  };

  for (const boat of boats) {
    // A wreck is a reflector to the *solver* (planning/04 §8) and it should be one here too —
    // but it is not a thing worth spending a warhead on, and a seeker that locked onto one would
    // turn every kill into a decoy for the next weapon through. It is skipped.
    if (boat.status === 'destroyed') continue;
    consider(boat.pos, boat.stats);
  }

  for (const decoy of decoys) {
    if (decoy.mimic === null || decoy.phase === 'spent') continue;
    consider(decoy.pos, decoy.mimic.stats);
  }

  return best;
}

/** Whether a bearing offset from the weapon's nose is inside `SEEKER_ARC`. */
export function inSeekerArc(facing: number, dx: number, dy: number): boolean {
  const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
  const off = Math.abs(((bearing - facing + 540) % 360) - 180);
  return off <= SEEKER_ARC;
}

/**
 * Whether the straight line between two points is unbroken water.
 *
 * Marched at the rock mask's own spacing, for the reason `outlineSamples` gives: a rock cell is
 * at least one cell wide, so a walk that never steps a full cell cannot step over one. The
 * endpoints are skipped — both of them are a hull, and a hull sitting against a wall must not
 * make itself invisible.
 */
export function clearWater(terrain: TerrainCollider, from: Vec2, to: Vec2): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const steps = Math.ceil(length / terrain.cellSize);
  if (steps <= 1) return true;

  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    if (terrain.isRock(from.x + dx * t, from.y + dy * t)) return false;
  }
  return true;
}
