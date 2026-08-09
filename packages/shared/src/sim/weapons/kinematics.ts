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
 * (`match/torpedo.ts#cruiseSpeed`) and steers at one point. What it has that a boat does not is a
 * **pitch band it obeys**: planning/04 §5 describes the band for submarines and the movement
 * phase does not implement it yet, but for torpedoes the band *is* the balance dimension
 * (05 §4), so it is here from the start.
 *
 * ## Getting round, at launch
 *
 * A weapon leaves the tube on the *boat's* heading and has to make its own way onto the bearing
 * of the point it was sent to (`launch.ts`). While it is doing that it is in the `launch` phase
 * and it is slow, which buys it a turning circle a tenth the size of its cruising one.
 *
 * A point **behind** it is not turned onto at all. The weapon takes the way off and **mirrors**,
 * which is the manoeuvre `match/movement.ts` documents at length for submarines — and it is the
 * same manoeuvre here rather than a similar one: `reversesToward` and `mirrorFacing` are
 * imported from there, so a weapon and a hull can never come to disagree about what reversing
 * means. The reason is stronger for a weapon than for a boat. A standard torpedo turning at
 * cruise sweeps a fifty-metre circle and a super-cavitating one sweeps three hundred, through
 * exactly the water the fleet that fired it is sitting in, with a live warhead and friendly fire
 * on (Q7). Braking to a stop and flipping costs a couple of seconds and touches nothing.
 *
 * ## The band, and turning through the vertical
 *
 * `facing` is confined to a wedge around horizontal on whichever side the weapon is travelling:
 * `[−maxPitch, +maxPitch]` going right, the same reflected going left. The clamp is applied to
 * the **demanded heading**, not to the weapon's actual facing, and that distinction is what
 * keeps a homing torpedo from getting stuck. Clamping the facing would wall a weapon in at 40°
 * with its target directly above it; clamping the demand lets it pick the reachable heading
 * closest to what it wants, turn toward that at its own rate, and — when the target is genuinely
 * behind it — reverse *through* the vertical, which is precisely how planning/04 §5 says a
 * course reversal works.
 *
 * The practical consequence, and the designed one: a super-cavitating weapon limited to ±12°
 * cannot follow a target that dives hard. It will demand 12° down, the target will keep going,
 * and the weapon will pass underneath it. That is its counter and it falls out of these fifteen
 * lines rather than being written anywhere.
 */

import {
  TORPEDO_ACCELERATION,
  TORPEDO_LAUNCH_ALIGNMENT,
  getWeapon,
} from '../../content/weapons.js';
import type { Vec2 } from '../../map/types.js';
import { mirrorFacing, reversesToward } from '../../match/movement.js';
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

/**
 * The nearest heading to `heading` that lies inside the pitch band.
 *
 * Two allowed wedges, one either side. A heading inside either is returned untouched; one
 * outside both is pulled to the closer of the four edges. `maxPitch` at or above 90° admits
 * everything, which no weapon in the table does but which the arithmetic should not break on.
 */
export function clampPitch(heading: number, maxPitch: number): number {
  const limit = Math.max(0, Math.min(90, maxPitch));
  const wrapped = normalizeDeg(heading);
  const fromRight = headingDelta(0, wrapped);
  const fromLeft = headingDelta(180, wrapped);

  if (Math.abs(fromRight) <= limit || Math.abs(fromLeft) <= limit) return wrapped;
  if (Math.abs(fromRight) < Math.abs(fromLeft)) {
    return normalizeDeg(fromRight > 0 ? limit : -limit);
  }
  return normalizeDeg(fromLeft > 0 ? 180 + limit : 180 - limit);
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
 * Whether a weapon is pointing where it is going closely enough to stop manoeuvring and open the
 * throttle — the launch phase's one exit condition.
 *
 * Against the clamped demand rather than the raw bearing, for the reason
 * `TORPEDO_LAUNCH_ALIGNMENT` gives. A weapon mid-flip is a long way from aligned by this test,
 * which is correct: it is pointing at the mirror of where it wants to be and has not flipped yet.
 */
export function alignedWith(torpedo: TorpedoState, at: Vec2): boolean {
  const def = getWeapon(torpedo.weapon);
  const demand = clampPitch(bearingDeg(torpedo.pos, at), def.maxPitch);
  return Math.abs(headingDelta(torpedo.facing, demand)) <= TORPEDO_LAUNCH_ALIGNMENT;
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
 */
export function stepTorpedo(torpedo: TorpedoState, steerTo: Vec2 | null, dt: number): TorpedoState {
  const def = getWeapon(torpedo.weapon);

  // Going back the way it came: brake and mirror rather than sweep a circle through the fleet
  // that fired it (see the header). Only while getting round — a weapon up to speed has
  // committed, and a homing one chasing a track astern is exactly the miss that ought to happen.
  if (torpedo.phase === 'launch' && steerTo !== null) {
    const bearing = bearingDeg(torpedo.pos, steerTo);
    if (reversesToward(torpedo.facing, bearing)) return flipToward(torpedo, bearing, dt);
  }

  const speed = approach(torpedo.speed, cruiseSpeed(torpedo), TORPEDO_ACCELERATION * dt);
  const facing =
    steerTo === null
      ? torpedo.facing
      : turnToward(
          torpedo.facing,
          clampPitch(bearingDeg(torpedo.pos, steerTo), def.maxPitch),
          def.turnRate,
          dt,
        );

  return advanced(torpedo, facing, speed, speed * dt);
}

/**
 * One tick of a reversal: take the way off, and mirror the moment it is off.
 *
 * `match/movement.ts#flipToward` for weapons, and the same three rules. The weapon keeps making
 * way while it brakes, because it is still making way. It pitches onto the *mirror* of the
 * bearing it wants as it slows, which costs nothing and is what lands the flip on that bearing
 * rather than merely on the correct side of it. And a weapon already stopped flips at once.
 *
 * The bearing is clamped to the pitch band twice over — once here and once through
 * `mirrorFacing`, which preserves pitch — so a weapon told to reverse onto something steeply
 * above it comes out of the flip at the steepest heading it is allowed rather than at one it
 * would immediately have to turn away from.
 */
function flipToward(torpedo: TorpedoState, bearing: number, dt: number): TorpedoState {
  const def = getWeapon(torpedo.weapon);
  const speed = approach(torpedo.speed, 0, TORPEDO_ACCELERATION * dt);
  const wanted = mirrorFacing(clampPitch(bearing, def.maxPitch));
  const facing = turnToward(torpedo.facing, wanted, def.turnRate, dt);

  if (speed === 0) return { ...torpedo, facing: mirrorFacing(facing), speed: 0 };
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
