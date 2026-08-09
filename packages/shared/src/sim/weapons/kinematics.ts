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
 * and it is slow, which buys it a turning circle a tenth the size of its cruising one — and it
 * stays there for `TORPEDO_LAUNCH_SETTLE_SECONDS` after it gets round, so that it leaves on a
 * bearing that has stopped moving rather than on one it has just touched.
 *
 * Two things about the demand it is turning onto are worth knowing before reading the code. While
 * it is still creeping it clamps to the **launch band** (`TORPEDO_LAUNCH_MAX_PITCH`) rather than
 * the weapon's cruise band, because the launch phase's whole job is to come onto the bearing of
 * the point it was sent to — a super-cavitating weapon sent at a target 30° up is pointed at it
 * here, and only loses the angle once the cruise band takes over at speed. And it is clamped to
 * the wedge on the side the weapon is **already travelling** (`clampPitchOnSide`) rather than to
 * the nearer wedge, which is what stops a weapon sent at something almost directly overhead from
 * chasing a demand that changes sides every time it drifts past.
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
 * The practical consequence, and the designed one: a super-cavitating weapon's ±40° band does
 * not rescue it, because the thing that loses it a target is the **turning circle**, not the
 * pitch band. It will have pointed at the target while still creeping — the launch band lets it
 * look — but the moment it opens the throttle it is committed to a line it cannot be talked out
 * of (`match/torpedo.ts#turningRadiusOf`: 55 m/s at 10 °/s is a 315 m circle). A target that
 * turns while it is on the way passes through the circle the weapon cannot leave. That is its
 * counter and it falls out of these fifteen lines rather than being written anywhere.
 */

import {
  TORPEDO_ACCELERATION,
  TORPEDO_FLIP_MARGIN,
  TORPEDO_LAUNCH_ALIGNMENT,
  TORPEDO_LAUNCH_MAX_PITCH,
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

/** Whether a heading is travelling rightward. Dead vertical counts as right, arbitrarily. */
export function goingRight(facing: number): boolean {
  return Math.cos((facing * Math.PI) / 180) >= 0;
}

/**
 * `heading`, clamped into the pitch wedge **on the side you name** rather than into whichever
 * wedge happens to be nearer.
 *
 * The difference only shows up near the vertical, and there it is the difference between a
 * weapon that works and one that does not. `clampPitch` picks the nearer wedge, so for a target
 * within a few degrees of straight up the demanded heading swings the whole way across — +40° to
 * 140° for a standard torpedo — the instant the weapon's own drift carries it past the target's
 * horizontal position. A weapon creeping under a point directly overhead therefore chases a
 * demand that changes sides faster than it can turn, never settles, and creeps at launch speed
 * until its clock runs out. Measured: a standard torpedo sent straight up spent 135 seconds — its
 * entire life — in the launch phase.
 *
 * Naming the side fixes it by making the demand a function of something that does not oscillate.
 * A launching weapon names the side it is already travelling, so the only thing that can change
 * it is the deliberate reversal (`stepTorpedo`), and a weapon told to climb at something almost
 * overhead commits to a side and climbs.
 *
 * `clampPitch` is still what a weapon uses once it is *running*: it has no reversal available by
 * then, so turning through the vertical is its only way onto a bearing behind it, and the
 * oscillation costs a fast weapon an arc rather than its whole life.
 */
export function clampPitchOnSide(heading: number, maxPitch: number, right: boolean): number {
  const limit = Math.max(0, Math.min(90, maxPitch));
  const axis = right ? 0 : 180;
  const off = headingDelta(axis, normalizeDeg(heading));
  return normalizeDeg(axis + Math.max(-limit, Math.min(limit, off)));
}

/**
 * The heading a weapon still in its launch phase is trying to hold: the bearing to its aim point,
 * pulled into the pitch wedge on the side it is travelling (`clampPitchOnSide`).
 *
 * The launch phase's whole job is to come onto the bearing of the point it was sent to, so this
 * clamps to the **launch band** (`TORPEDO_LAUNCH_MAX_PITCH`) rather than the weapon's cruise
 * band — a ±40° load sent at a target 50° up is pointed at it here, and only loses the angle
 * once the cruise band takes over at speed. Never tighter than the cruise band either way: a
 * weapon whose `maxPitch` is already wider launches on that.
 *
 * One function rather than the same three lines in the steering and in the alignment test,
 * because those two disagreeing is a weapon that turns toward one heading and is judged against
 * another — which is a weapon that never leaves the launch phase.
 */
export function launchDemand(
  torpedo: TorpedoState,
  at: Vec2,
  right = goingRight(torpedo.facing),
): number {
  const def = getWeapon(torpedo.weapon);
  return clampPitchOnSide(
    bearingDeg(torpedo.pos, at),
    Math.max(TORPEDO_LAUNCH_MAX_PITCH, def.maxPitch),
    right,
  );
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
 * the demand and there is nothing left to turn" rather than "close enough".
 *
 * The difference is not cosmetic, and which loads it is not cosmetic *for* is the point. A
 * weapon that opens the throttle a few degrees off has to finish the turn at cruising speed,
 * where its circle is five to twenty times wider (`match/torpedo.ts#turningRadiusOf`) — a
 * super-cavitating weapon goes from a forty-metre circle to a three-hundred-metre one. The
 * standard torpedo hides that error, because its seeker re-aims it on the way in; **every other
 * load flies the heading it left here with**, so for the drone, the decoy and the
 * super-cavitating torpedo the last few degrees of the launch turn are the shot.
 *
 * Against the launch demand rather than the raw bearing: the demand is the heading the weapon can
 * actually reach this tick, side-pinned and capped by the launch band, so judging against it is
 * what lets a weapon sent at something near-vertical count the reachable edge of its launch band
 * as pointed — otherwise it would creep forever trying to point at a heading that was never
 * on offer. It is the cruise band, not the launch band, that a weapon loses the aim to: a ±40°
 * load pointed at a 45° climb is pointed at it, and gives it back up the moment it opens the
 * throttle (`planning/05 §4`).
 *
 * A weapon mid-flip is a long way from aligned by this test, which is correct: it is pointing at
 * the mirror of where it wants to be and has not flipped yet.
 */
export function alignedWith(torpedo: TorpedoState, at: Vec2): boolean {
  const error = headingDelta(torpedo.facing, launchDemand(torpedo, at));
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
 */
export function stepTorpedo(torpedo: TorpedoState, steerTo: Vec2 | null, dt: number): TorpedoState {
  const def = getWeapon(torpedo.weapon);

  const launching = torpedo.phase === 'launch' && steerTo !== null;

  // Going back the way it came: brake and mirror rather than sweep a circle through the fleet
  // that fired it (see the header). Only while getting round — a weapon up to speed has
  // committed, and a homing one chasing a track astern is exactly the miss that ought to happen.
  if (launching && steerTo !== null && worthReversing(torpedo, steerTo)) {
    return flipToward(torpedo, bearingDeg(torpedo.pos, steerTo), dt);
  }

  const speed = approach(torpedo.speed, cruiseSpeed(torpedo), TORPEDO_ACCELERATION * dt);
  const facing =
    steerTo === null
      ? torpedo.facing
      : turnToward(
          torpedo.facing,
          // Side-preserving while it is still getting round, so the demand cannot swing across
          // the vertical faster than the weapon can turn; nearest-wedge once it is running,
          // because by then reversing is the only way onto a bearing behind it
          // (`clampPitchOnSide`).
          launching
            ? launchDemand(torpedo, steerTo)
            : clampPitch(bearingDeg(torpedo.pos, steerTo), def.maxPitch),
          def.turnRate,
          dt,
        );

  return advanced(torpedo, facing, speed, speed * dt);
}

/**
 * Whether reversing would actually buy this weapon anything.
 *
 * `reversesToward` asks the geometric question — is the point abaft the beam and on the other
 * side — and for a boat that is the whole of it. A weapon needs one more condition, because it
 * is asked the question forty times a second while creeping *under* the point it was sent to: a
 * target a few metres the other side of vertical satisfies "the other side" by a hair, and a
 * weapon that reversed for it would brake to a stop, flip, drift a few metres past, and reverse
 * again, forever, having gained nothing either time.
 *
 * So the horizontal offset has to be worth stopping for. `TORPEDO_FLIP_MARGIN` is well inside
 * every load's arrival radius (`match/torpedo.ts#turningRadiusOf`), which is the honest bar: an
 * offset the weapon counts as *arrived* at is not one to give up all its speed for.
 */
function worthReversing(torpedo: TorpedoState, at: Vec2): boolean {
  if (Math.abs(at.x - torpedo.pos.x) < TORPEDO_FLIP_MARGIN) return false;
  return reversesToward(torpedo.facing, bearingDeg(torpedo.pos, at));
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
  // The demand on the side it is flipping *to*, mirrored back — which is the heading it has to
  // be holding at the moment the way comes off for the mirror to land on that demand.
  const arriving = clampPitchOnSide(bearing, def.maxPitch, !goingRight(torpedo.facing));
  const facing = turnToward(torpedo.facing, mirrorFacing(arriving), def.turnRate, dt);

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
