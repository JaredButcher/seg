/**
 * The torpedo seeker — a very small, very deaf sonar bolted to a warhead. Two of them.
 *
 * The homing pair carry the same receiver in the same nose cone, with the same array gain and the
 * same self-noise problem (`SEEKER_GAIN`, `SEEKER_SELF_NOISE`), and steer off the same `track` at
 * the same turn rate. What differs is whether it is wired to transmit:
 *
 * - **`seekerLook`** is the active one. It fires a 95 dB pulse and reads its own echo off a hull,
 *   so the path is paid **twice** and the reflection once, which is why its reach is a few hundred
 *   metres. Its reach is also a *constant*: an echo comes back off a hull whatever that hull is
 *   doing, so nothing a target does to be quiet moves the number.
 * - **`seekerListen`** is the passive one. It transmits nothing and reads a hull's own radiated
 *   noise, so the path is paid **once** and there is no reflection to swallow. That makes its
 *   reach a fact about the *target* rather than about the weapon: a Light at flank is heard from
 *   870 m and a Heavy from 2.7 km, while the same Light holding still is not heard until 190 m.
 *   The whole counter to the weapon is the one every submariner already knows.
 *
 * Neither of them tells anybody anything (see the pooling argument below), and both of them are
 * fooled by an active decoy in exactly the same way and for exactly the same reason.
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
 * stopped submarine's is −6. Together those put acquisition at roughly 345 m against a bare
 * hull, and an anechoic coating takes a further bite — 299 m against a Light. That number *is* the mechanic the brief
 * asks for: the enable point has to be put in front of where the target will be, close enough
 * that it is inside this when the sonar wakes up. A generous seeker would make the aim point
 * decoration.
 *
 * The passive seeker is deaf against the same 20 dB of its own machinery, and that is what stops
 * the one-way path from making it absurd. Paying the ocean once instead of twice is worth a great
 * deal — a Heavy at flank is audible to it from 2.7 km — but the floor it has to clear is a
 * torpedo motor bolted to the hydrophone, so a Light at all stop is inside 190 m before it
 * registers at all. Both of those are the same arithmetic with the same constant; neither is a
 * balance number written down separately.
 *
 * ## Noisemakers, and why the two receivers are beaten differently
 *
 * A noisemaker is 96 dB of broadband racket sinking through the water (`content/weapons.ts`), and
 * what it does to these two is not one mechanic applied twice. It is one *fact* — there is now
 * something enormously loud off the weapon's nose — read by two receivers that were already asking
 * different questions:
 *
 * - **The passive one is distracted.** It hunts the loudest source it can hear and a noisemaker is
 *   simply the loudest source; it arrives through `seekerListen`'s ordinary candidate list, wins
 *   loudest-wins, and the weapon turns and goes for it. Nothing here knows it has been had, which
 *   is the same property that makes the active decoy work and for the same reason.
 * - **The active one is blinded.** It cannot be distracted — the thing is a metre of drum and
 *   returns nothing worth steering at — so the racket goes where racket belongs, into the noise
 *   floor its own echo has to clear (`jammingAt`, `jammedThreshold`). A 95 dB pulse against a
 *   floor two hundred metres from a noisemaker has nothing left, and the weapon runs on straight.
 *
 * **Both are gated by `SEEKER_ARC`**, which is the one rule that makes the countermeasure
 * teachable: it works on a weapon that is *pointed at it*. That falls straight out of the passive
 * side, where the arc gates every candidate anyway; the active side is written to match rather than
 * to be omnidirectional, because a receiver's gain is a gain in the direction it is looking, and
 * because "put it between yourself and the weapon" is a decision and "drop one anywhere" is not.
 *
 * The floor is deliberately **not** raised for the passive receiver as well. Physically it is the
 * same swamping, but the model already expresses it: swamped by the loudest thing *is* loudest-wins
 * picking the noisemaker. Charging it twice would make a passive seeker unable to hear the very
 * contact it is being pulled onto, which is nonsense the first time anyone tests it.
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
import { toDecibels, toPower } from '../../math/decibels.js';
import type { TorpedoState } from '../../match/torpedo.js';
import { wreckHasLeftMap, type BoatState } from '../../match/world.js';
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
  return jammedThreshold(-Infinity, tuning);
}

/**
 * The same threshold with something loud in the water beside the weapon — `background` dB of it, at
 * the weapon's own position.
 *
 * The one function a noisemaker beats an active seeker through, and it is the ocean's own
 * arithmetic rather than a rule about countermeasures: `noiseFloorOf` is what every listener in the
 * game competes against, and all this does is stop passing it `-Infinity`. So the weighting a
 * background reading gets (`backgroundNoiseFraction`), the way it sums with the weapon's own
 * machinery, and the detection threshold on the far side are all the ones a submarine obeys, and a
 * tuning pass on `content/acoustics.ts` moves the jamming with everything else.
 *
 * `seekerThreshold` is this at `-Infinity` — quiet water — which is what the reach rings, the
 * threat alert, and the debug overlay all want: what the weapon can do when nobody is jamming it.
 * A derived warning that moved with a noisemaker two hundred metres away would be telling the
 * player something their own sonar has no way of knowing.
 */
export function jammedThreshold(background: number, tuning?: AcousticTuning): number {
  return returnThreshold(noiseFloorOf(background, SEEKER_SELF_NOISE, tuning), SEEKER_GAIN, tuning);
}

/**
 * How much noise the jammers in the water are putting at this weapon's receiver, dB — or
 * `-Infinity` for the ordinary case of an ocean with none in it.
 *
 * Power-summed over every candidate, so two noisemakers are worth about three decibels more than
 * one rather than the louder of the two. The level is the plain one-way path `seekerListen` uses,
 * off the same `sourceLevel` the solve puts in the water, because a jammer heard by a torpedo and
 * the same jammer heard by a submarine must not be two different loudnesses.
 *
 * **Off the nose, and through water.** `SEEKER_ARC` gates it for the reason the file header gives —
 * a countermeasure works on a weapon pointed at it — and `clearWater` gates it because rock is
 * cover from noise exactly as it is cover from everything else here. The line-of-sight test runs
 * last and only for a jammer that would otherwise have counted, the same order every other
 * expensive test in this file is in.
 *
 * Returns `-Infinity` rather than `0` for nothing, because zero is the quiet ocean on this scale
 * and would quietly raise every seeker's floor by three decibels the day this was called with an
 * empty list.
 */
export function jammingAt(
  torpedo: TorpedoState,
  jammers: readonly SeekerSource[],
  terrain: TerrainCollider | null,
  tuning?: AcousticTuning,
): number {
  if (jammers.length === 0) return -Infinity;

  let power = 0;
  for (const jammer of jammers) {
    const dx = jammer.at.x - torpedo.pos.x;
    const dy = jammer.at.y - torpedo.pos.y;
    const range = Math.hypot(dx, dy);
    if (!inSeekerArc(torpedo.facing, dx, dy)) continue;

    const level = jammer.sourceLevel - transmissionLoss(range, tuning);
    if (level <= -Infinity) continue;
    if (terrain !== null && !clearWater(terrain, torpedo.pos, jammer.at)) continue;

    power += toPower(level);
  }

  return power <= 0 ? -Infinity : toDecibels(power);
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
 *
 * **`jamming` is the only thing that can make this weapon deafer than its data sheet**, and it is a
 * level rather than a list because the caller has already resolved one per tick for every weapon in
 * the water (`sim/weapons/phase.ts`). `-Infinity` is quiet water and restores the constant reach
 * the paragraphs above describe.
 */
export function seekerLook(
  torpedo: TorpedoState,
  boats: readonly BoatState[],
  decoys: readonly TorpedoState[],
  terrain: TerrainCollider | null,
  tuning?: AcousticTuning,
  jamming = -Infinity,
): SeekerReturn | null {
  const def = getWeapon(torpedo.weapon);
  if (def.seekerPingLevel <= 0) return null;

  const gate = jammedThreshold(jamming, tuning);
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
    // A wreck is a reflector to the *solver* (planning/04 §8, revised) and it is one here too:
    // it still radiates (`sim/acoustics/boats.ts#wreckSourceLevel`), so it is a real echo rather
    // than a courtesy, and a seeker that finds one is allowed to close on it — the fuze
    // (`weapons/phase.ts#touchingHull`) will let it detonate there. Only a wreck that has sunk
    // out of the map is skipped; there is nothing left there to hear.
    if (wreckHasLeftMap(boat)) continue;
    consider(boat.pos, boat.stats);
  }

  for (const decoy of decoys) {
    if (decoy.mimic === null || decoy.phase === 'spent') continue;
    consider(decoy.pos, decoy.mimic.stats);
  }

  return best;
}

/**
 * One thing a passive seeker might hear, reduced to the only two facts it needs.
 *
 * A position and a source level, which is deliberately *not* a boat: the caller resolves every
 * candidate through `sim/acoustics/boats.ts#boatEntity` or `#torpedoEntity` first, so what arrives
 * here is the level the solver would put in the water — machinery, flow noise, cavitation, hull
 * stress, a bang that is still ringing, and its own active pulse if it is pinging, all already
 * summed. A passive seeker that recomputed any of that would be a second opinion about how loud a
 * submarine is, and the two would drift apart on the first tuning pass.
 *
 * It is also what keeps the decoy honest for free. A decoy reaches `torpedoEntity` wearing the
 * launching boat's stat block and comes out radiating that boat's level (`match/torpedo.ts#
 * DecoyMimic`), so it arrives here indistinguishable from the submarine it is imitating — which is
 * the same thing `seekerLook` gets from the same source and for the same reason.
 */
export interface SeekerSource {
  readonly at: Vec2;
  /** dB at the reference range, exactly as the solve has it. See above. */
  readonly sourceLevel: number;
}

/**
 * What a passive seeker hears right now, or `null` for an ocean with nothing loud enough in it.
 *
 * The counterpart of `seekerLook`, and the differences are the two that matter and no others:
 *
 * 1. **The path is paid once.** No pulse goes out, nothing is reflected, so there is no second
 *    transit and no `hullMaterial` absorption to swallow. An anechoic coating is worth nothing
 *    against this — it is a coating that absorbs *incoming* sound, and this weapon is listening to
 *    noise the target is making itself. That is not an oversight; it is the one thing a passive
 *    sensor is genuinely better at, and the reason a stealth build cannot simply out-tech it.
 * 2. **The level is the target's, not the weapon's.** `seekerEcho` starts from what this weapon
 *    transmits; this starts from what the *other* thing radiates. So the same weapon has a
 *    different reach against every contact in the water and a different reach against the same
 *    contact ten seconds later, and going quiet is a real, continuous, immediate defence rather
 *    than a threshold to cross.
 *
 * Everything else is deliberately identical — the same `SEEKER_ARC` off the nose, the same
 * loudest-wins tiebreak, the same line-of-sight test last, and the same threshold, because it is
 * the same receiver. Two seekers that disagreed about any of those would be two weapons that
 * behave differently for reasons no player could see.
 */
export function seekerListen(
  torpedo: TorpedoState,
  sources: readonly SeekerSource[],
  terrain: TerrainCollider | null,
  tuning?: AcousticTuning,
): SeekerReturn | null {
  const gate = seekerThreshold(tuning);
  let best: SeekerReturn | null = null;

  for (const source of sources) {
    const dx = source.at.x - torpedo.pos.x;
    const dy = source.at.y - torpedo.pos.y;
    const range = Math.hypot(dx, dy);
    // Inside its own length is not a detection, it is a hit — and the fuze has already had it.
    if (range <= 0) continue;
    if (!inSeekerArc(torpedo.facing, dx, dy)) continue;

    const excess = source.sourceLevel - transmissionLoss(range, tuning) - gate;
    if (excess < 0) continue;
    if (best !== null && excess <= best.excess) continue;
    // The expensive test last, and only for a contact that would otherwise be heard.
    if (terrain !== null && !clearWater(terrain, torpedo.pos, source.at)) continue;

    best = { at: source.at, excess };
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
