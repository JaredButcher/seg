/**
 * How a weapon in the water moves — planning/04 §1 step 5, the kinematics half.
 *
 * Pure, one torpedo, one tick, like `match/movement.ts` is for boats and for the same reason: a
 * replay reproduces a match from its command log (04 §9), and a step that wandered would corrupt
 * every replay that touched it.
 *
 * ## It is a simpler boat
 *
 * No throttle, no orders, no waypoint queue — a torpedo chases the one speed its phase asks for
 * (`match/torpedo.ts#cruiseSpeed`) and steers at one point. What it has that a boat does not is
 * that **it does not care which way is up**: a weapon turns onto the bearing of the thing it is
 * steering at, whatever that bearing is, at one rate, through the vertical if that is where the
 * short way round goes.
 *
 * ## A weapon has no pitch band
 *
 * It used to. planning/04 §5 describes a band for submarines and the movement phase does not
 * implement it yet; weapons carried one from the start because 05 §4 made it the balance
 * dimension — a wedge around horizontal on whichever side the weapon was travelling, plus a wider
 * band it was allowed to point at while creeping, plus a rule for which of the two wedges a
 * demand near the vertical belonged to.
 *
 * All of it is gone, and playtesting is why: a weapon that could not follow a target which simply
 * swam upward turned the vertical into an escape hatch rather than a dimension. The band's
 * three-way interaction with side-pinning and with the launch reversal was also the source of
 * every steering bug this file ever had — a demand that changed sides faster than the weapon
 * could turn, a weapon walled in at 40° with its target overhead, a launch alignment judged
 * against a heading the cruise band would immediately take away.
 *
 * What remains is one law: **turn toward the bearing at `turnRate`.** Nothing is clamped, nothing
 * is reflected, and up and sideways cost the same.
 *
 * ## Getting round, at launch
 *
 * A weapon leaves the tube on the *boat's* heading and has to make its own way onto the bearing
 * of the point it was sent to (`launch.ts`). While it is doing that it is in the `launch` phase
 * and it is slow, which buys it a turning circle a tenth the size of its cruising one — and it
 * stays there for `TORPEDO_LAUNCH_SETTLE_SECONDS` after it gets round, so that it leaves on a
 * bearing that has stopped moving rather than on one it has just touched.
 *
 * A point **behind** it is turned onto like any other. It used to be reached by braking to a stop
 * and mirroring, the manoeuvre `match/movement.ts` documents at length for submarines, because
 * with a pitch band in force the weapon could not rotate through the vertical to get there at
 * all. With the band gone the flip has nothing left to buy: the weapon is creeping at
 * `TORPEDO_LAUNCH_SPEED` while it comes about, and at that speed its circle is a few tens of
 * metres rather than the fifty to three hundred a weapon at cruise would sweep through its own
 * fleet. Boats still flip — a hull's band is real and `match/movement.ts` still owns that
 * manoeuvre. Weapons no longer have anything to flip *out of*.
 *
 * The cost of an over-the-shoulder shot is therefore paid in seconds of creep rather than in
 * seconds of braking, and it is paid hardest by the slowest turner: a super-cavitating weapon at
 * 10 °/s spends eighteen seconds of its twenty-four-second life coming about. That is the tax on
 * firing backwards, and it is now the same tax whichever way "backwards" points.
 *
 * ## What actually loses a weapon its target
 *
 * The **turning circle**, and only that. A super-cavitating weapon will point wherever the launch
 * phase is told to point it, but the moment it opens the throttle it is committed to a line it
 * cannot be talked out of (`match/torpedo.ts#turningRadiusOf`: 55 m/s at 10 °/s is a 315 m
 * circle). A target that turns while it is on the way passes through the circle the weapon cannot
 * leave. That is its counter, and with the pitch band gone it is the whole of its counter.
 */

import {
  TORPEDO_ACCELERATION,
  TORPEDO_LAUNCH_ALIGNMENT,
  getWeapon,
} from '../../content/weapons.js';
import type { Vec2 } from '../../map/types.js';
import { cruiseSpeed, turningRadiusOf, type TorpedoState } from '../../match/torpedo.js';

/** Degrees, wrapped into `[0, 360)`. */
export function normalizeDeg(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** The short way round from `facing` to `heading`: −180 (clockwise) to +180. */
export function headingDelta(facing: number, heading: number): number {
  return ((heading - facing + 540) % 360) - 180;
}

export function bearingDeg(from: Vec2, to: Vec2): number {
  return normalizeDeg((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI);
}

/** Rotate `facing` toward `heading` by at most `turnRate·dt`, taking the short way round. */
export function turnToward(facing: number, heading: number, turnRate: number, dt: number): number {
  const step = turnRate * dt;
  return normalizeDeg(facing + Math.max(-step, Math.min(step, headingDelta(facing, heading))));
}

/**
 * Whether a weapon has arrived at a point — which for something that cannot slow down means
 * "as close as its turning circle will ever let it get".
 *
 * The same geometry `match/movement.ts` documents at length: a point inside the circle cannot be
 * touched however long the weapon orbits. A boat answers that by giving up speed; a torpedo has
 * no throttle, so it answers by counting the point as reached. Without this a standard torpedo
 * whose enable point it slightly overshot would circle it forever instead of switching its
 * seeker on, which is the bug this whole paragraph exists to have already fixed.
 *
 * `step` widens it to at least one tick of travel, so a weapon cannot skip past a point between
 * two ticks and be judged never to have arrived.
 */
export function hasArrived(torpedo: TorpedoState, at: Vec2, step: number): boolean {
  const distance = Math.hypot(at.x - torpedo.pos.x, at.y - torpedo.pos.y);
  return distance <= Math.max(step, turningRadiusOf(torpedo));
}

/**
 * Whether a weapon has finished getting round — the launch phase's one exit condition.
 *
 * **On the heading, not near it.** `TORPEDO_LAUNCH_ALIGNMENT` is half a degree, which is less
 * than one tick of the slowest turn rate in the table, so this says "`turnToward` has landed on
 * the bearing and there is nothing left to turn" rather than "close enough".
 *
 * The difference is not cosmetic, and which loads it is not cosmetic *for* is the point. A
 * weapon that opens the throttle a few degrees off has to finish the turn at cruising speed,
 * where its circle is five to twenty times wider (`match/torpedo.ts#turningRadiusOf`) — a
 * super-cavitating weapon goes from a forty-metre circle to a three-hundred-metre one. The
 * standard torpedo hides that error, because its seeker re-aims it on the way in; **every other
 * load flies the heading it left here with**, so for the drone, the decoy and the
 * super-cavitating torpedo the last few degrees of the launch turn are the shot.
 *
 * Against the raw bearing to the aim point, because that is now the only heading there is: a
 * weapon is asked to point at the thing it was sent to and nothing takes any of that angle back
 * from it at the throttle. When the bearing is one the weapon cannot settle on at all — an aim
 * point *inside* its own turning circle, where the demand swings as fast as the weapon orbits —
 * it is `sim/weapons/phase.ts#settle`'s arrival valve rather than this that ends the launch.
 */
export function alignedWith(torpedo: TorpedoState, at: Vec2): boolean {
  const error = headingDelta(torpedo.facing, bearingDeg(torpedo.pos, at));
  return Math.abs(error) <= TORPEDO_LAUNCH_ALIGNMENT;
}

/**
 * Advance one weapon by `dt` seconds, steering at `steerTo` — or holding its course when that is
 * `null`, which is what an unguided weapon past its aim point does.
 *
 * Speed, facing, position, and the fuel counter, and nothing else: the fuze, the seeker, and the
 * phase transitions are the phase's business (`phase.ts`). Keeping them apart is what makes this
 * testable by asking "where is it after two seconds" with no map and no fleet.
 *
 * Speed is *approached* rather than only built, because there are now three things a weapon can
 * be asked for — creep, cruise, and stop — and one of them is slower than what it is doing
 * (`match/torpedo.ts#cruiseSpeed`). It brakes as hard as it accelerates: a weapon is a motor and
 * a control surface in a fluid, and inventing a second, weaker number for slowing down would be
 * a tuning knob nobody could feel.
 *
 * Three lines, and the shape of them is the point. There is no branch on the phase, no branch on
 * which side of the vertical the demand is, and no branch for a bearing astern — a weapon turns
 * toward what it is steering at and that is all it ever does (see the header).
 */
export function stepTorpedo(torpedo: TorpedoState, steerTo: Vec2 | null, dt: number): TorpedoState {
  const def = getWeapon(torpedo.weapon);

  const speed = approach(torpedo.speed, cruiseSpeed(torpedo), TORPEDO_ACCELERATION * dt);
  const facing =
    steerTo === null
      ? torpedo.facing
      : turnToward(torpedo.facing, bearingDeg(torpedo.pos, steerTo), def.turnRate, dt);

  return advanced(torpedo, facing, speed, speed * dt);
}

/** `step` metres along `facing`, with the fuel counter kept in step. */
function advanced(
  torpedo: TorpedoState,
  facing: number,
  speed: number,
  step: number,
): TorpedoState {
  const radians = (facing * Math.PI) / 180;
  return {
    ...torpedo,
    pos: {
      x: torpedo.pos.x + Math.cos(radians) * step,
      y: torpedo.pos.y + Math.sin(radians) * step,
    },
    facing,
    speed,
    travelled: torpedo.travelled + step,
  };
}

/** Move `value` toward `target` by at most `maxDelta`, in either direction. */
function approach(value: number, target: number, maxDelta: number): number {
  if (value < target) return Math.min(value + maxDelta, target);
  return Math.max(value - maxDelta, target);
}
