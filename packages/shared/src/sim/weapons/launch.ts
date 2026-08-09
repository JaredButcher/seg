/**
 * Putting a weapon in the water — planning/04 §7 step 1.
 *
 * One tube, one torpedo, and the three consequences that have to happen together: the weapon
 * exists, the tube starts reloading, and the boat makes the loudest noise it can make short of
 * being hit. Together rather than in three places, because a launch that produced a torpedo and
 * forgot the transient would be a silent shot — and the whole design of this game is that
 * shooting tells the enemy where you are.
 *
 * ## The salvo is one bang
 *
 * Firing four tubes at once sounds exactly as loud as firing one. That is `withTransient`'s
 * same-kind-same-tick rule doing its job (`match/world.ts`), and it is correct rather than a
 * limitation: power-summing four copies of one launch would add six decibels the ocean never
 * heard, and a boat that could be *quieter* by staggering its shots would have a mechanic nobody
 * designed.
 *
 * ## Where a weapon appears
 *
 * Ahead of the bow, clear of the hull that fired it, on the firing boat's heading. Not at the
 * boat's centre — a torpedo born inside its own submarine would spend its arming delay
 * overlapping the thing it is least allowed to hit, and the first thing the collision-shaped
 * part of the fuze would find is home.
 *
 * The launch heading is the **boat's**, not the bearing to the aim point. A tube points where
 * the boat points, and the weapon turns onto its target after it is clear — which is why an
 * over-the-shoulder shot is a bad shot and why turning to face a target before firing is worth
 * doing. Giving the weapon a free instant rotation at launch would delete that decision. What
 * the weapon does about it is the `launch` phase's business (`match/torpedo.ts`).
 */

import { getHull } from '../../content/hulls.js';
import { TORPEDO_LENGTH, getWeapon, type WeaponId } from '../../content/weapons.js';
import type { Vec2 } from '../../map/types.js';
import type { DecoyMimic, TorpedoState } from '../../match/torpedo.js';
import { fired } from '../../match/tubes.js';
import { withTransient, type BoatState, type EntityId } from '../../match/world.js';

/**
 * Metres between the tip of the bow and the tail of a weapon just launched.
 *
 * Comfortably outside `TORPEDO_PROXIMITY_FUZE`, and that is now a requirement rather than a
 * happy accident: a weapon spends its first seconds slow (the `launch` phase) and one that keeps
 * station with its firer — a decoy, which runs at that boat's own flank speed — never pulls away
 * at all. Born inside the fuze radius, it would sit there until the interlock lifted and then
 * scuttle itself on the bow that fired it.
 */
export const LAUNCH_CLEARANCE = 16;

export interface LaunchRequest {
  readonly boat: BoatState;
  /** Which tube. The caller has already checked it `canFire`. */
  readonly tubeIndex: number;
  /** The id to mint the weapon with — `MatchState.nextEntityId`. */
  readonly id: EntityId;
  /** Where the player clicked: an enable point, or a pure aim point. See `TorpedoState.aim`. */
  readonly aim: Vec2;
  readonly tick: number;
  readonly tickHz: number;
}

export interface LaunchResult {
  /** The firing boat: its tube reloading, and a `torpedo-launch` ringing on it. */
  readonly boat: BoatState;
  readonly torpedo: TorpedoState;
}

/**
 * Fire one tube.
 *
 * The caller owns the *decision* — that this account commands the boat, that the tube is loaded
 * with something deployable, that the aim point is on the map. This owns the *consequence*, and
 * it assumes all three: a launch that re-checked them would be a second copy of rules that live
 * in `match/tubes.ts` and the handler, and two copies is how they come to disagree.
 */
export function launch(request: LaunchRequest): LaunchResult {
  const { boat, tubeIndex, id, aim, tick, tickHz } = request;
  const tube = boat.tubes[tubeIndex];
  if (tube === undefined)
    throw new Error(`boat ${String(boat.id)} has no tube ${String(tubeIndex)}`);

  const radians = (boat.facing * Math.PI) / 180;
  const reach = getHull(boat.hull).length / 2 + LAUNCH_CLEARANCE + TORPEDO_LENGTH / 2;
  const pos = {
    x: boat.pos.x + Math.cos(radians) * reach,
    y: boat.pos.y + Math.sin(radians) * reach,
  };

  const torpedo: TorpedoState = {
    id,
    weapon: tube.weapon,
    team: boat.team,
    owner: boat.owner,
    firedBy: boat.id,
    firedTick: tick,
    aim,
    mimic: mimicOf(boat, tube.weapon),
    pos,
    facing: boat.facing,
    // Out of the tube with way on: a weapon does not start from a standstill, and one that did
    // would be overtaken by the boat that fired it. It still has to accelerate to cruise, which
    // is what gives a super-cavitating shot its two seconds of winding up.
    speed: Math.max(boat.speed, LAUNCH_SPEED),
    travelled: 0,
    // Every load starts by getting round onto the bearing it was sent on, whatever it is, and
    // holds it before opening the throttle (`match/torpedo.ts#TorpedoPhase`). Nothing here
    // decides any of that; the phase does. Nothing is aligned at the instant of launch — even a
    // weapon already pointing at its target has to hold that for a tick to be believed.
    phase: 'launch',
    alignedTick: 0,
    track: null,
    trackTick: 0,
    lastPingTick: 0,
    // The launch rings on the *boat*, not on the weapon. A tube firing is a noise a submarine
    // makes — it is the impulse charge and the hull ringing with it — and putting it on the
    // torpedo would move the loudest clue in the game a hundred metres off the thing that
    // produced it, which is exactly the hundred metres a listener is trying to resolve.
    transients: [],
  };

  return {
    boat: withTransient(
      {
        ...boat,
        tubes: boat.tubes.map((candidate) =>
          candidate.index === tubeIndex ? fired(candidate, boat.stats) : candidate,
        ),
      },
      'torpedo-launch',
      tick,
      tickHz,
    ),
    torpedo,
  };
}

/** m/s a weapon leaves the tube at, before its own motor takes over. */
export const LAUNCH_SPEED = 6;

/**
 * The boat a `decoy` load is to imitate — a snapshot of this one — or `null` for every other
 * load.
 *
 * Taken here, at the one moment the weapon and the boat are in the same function, and taken by
 * *value*: what the decoy imitates is the submarine as it was when the tube fired, not whatever
 * that submarine becomes. See `match/torpedo.ts#DecoyMimic` for why that is the interesting half
 * of the mechanic rather than an implementation shortcut.
 */
function mimicOf(boat: BoatState, weapon: WeaponId): DecoyMimic | null {
  if (getWeapon(weapon).behaviour !== 'decoy') return null;
  return { hull: boat.hull, stats: boat.stats };
}
