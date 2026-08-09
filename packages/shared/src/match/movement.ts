/**
 * @seg/shared/match/movement — advancing boats along their orders.
 *
 * planning/04 §1's movement phase, in pure form: one boat, one tick, a new `BoatState`. Pure
 * because the runtime's `tick()` is meant to be a map over the boats (planning/04 §4) and
 * because a replay reproduces a match from its command log — a movement step that wandered
 * would corrupt every replay that touched it (04 §9).
 *
 * ## What a transit order does
 *
 * The boat accelerates toward its throttle notch's speed and steers toward the first waypoint
 * (rotation limited by `turnRate`, which is why the boat curves rather than snapping about).
 * When it comes within reach of a waypoint it pops it and the next one takes over; when the
 * queue empties it has arrived, drops to a stop, and returns to `hold`.
 *
 * ## Turning circles, and the boat that orbits its own waypoint
 *
 * Turn rates are deliberately slow (planning/04 §5) — a Heavy at flank needs the better part of
 * a kilometre of sea to come about. A boat that arrives at a waypoint fast and off-bearing
 * therefore cannot bend onto it: the point sits *inside* its turning circle, the boat sweeps
 * past, comes round, and misses again, forever. That is the orbit, and it is geometry rather
 * than a bug in the steering — no steering law reaches a point it cannot turn tightly enough
 * to touch.
 *
 * So the phase asks the question directly (`maxApproachSpeed`) and answers it differently
 * depending on which waypoint it is:
 *
 * - **The last one** is where the player wants the boat, so the boat gives up speed to get
 *   there: the throttle notch is capped at the fastest speed that keeps the point outside the
 *   turning circle. Approach off-bearing and the boat slows into the turn, then winds back up
 *   to the notch as it comes round onto the bearing.
 * - **An intermediate one** is a route hint, not a destination, so the boat gives up the
 *   waypoint instead of its speed: the moment the point falls inside the turning circle it is
 *   counted as made good and the next leg takes over. Slowing to thread a corner the player
 *   only meant as "go roughly this way" would be the wrong trade.
 *
 * ## The acceleration is a lie
 *
 * `MOVEMENT_ACCELERATION` is a game number, not a physics one — a real submarine needs minutes
 * to gain a couple of knots, and this game is about deciding where to be, not about waiting to
 * get there. The phase accelerates in under two seconds from a standstill to flank.
 */

import type { Vec2 } from '../map/types.js';
import { HOLDING, throttleSpeedFor, type BoatState } from './world.js';

/** Acceleration, m/s². Unrealistically fast for gameplay — see the header. */
export const MOVEMENT_ACCELERATION = 10;

/**
 * The fastest a boat can travel and still be able to curve onto a point `distance` metres away
 * and `offBearing` degrees off the bow, in m/s.
 *
 * A boat under way is on a circle of radius `r = v/ω` (ω being `turnRate` in radians). Put the
 * boat at the origin looking down `+x` and the point at bearing θ, and the point lies inside
 * that circle — unreachable however long the boat holds the turn — exactly when
 * `distance < 2·r·sin θ`. Inverting for `v` gives this cap; a boat at or under it keeps the
 * point on or outside the circle, and its line-of-sight rate at most half its turn rate, so the
 * bearing error closes rather than winding round.
 *
 * `Infinity` for a point dead ahead or dead astern: neither is inside a turning circle at any
 * speed, so neither constrains one.
 */
export function maxApproachSpeed(distance: number, offBearing: number, turnRate: number): number {
  const sine = Math.abs(Math.sin((offBearing * Math.PI) / 180));
  if (sine < 1e-9) return Infinity;
  return (((turnRate * Math.PI) / 180) * distance) / (2 * sine);
}

/** Advance one boat by `dt` seconds. `hold` and destroyed boats do not move. */
export function stepBoat(boat: BoatState, dt: number): BoatState {
  if (boat.status === 'destroyed' || boat.order.kind !== 'transit') return boat;

  const targetPoint = boat.order.waypoints[0];
  if (targetPoint === undefined) return { ...boat, speed: 0, order: HOLDING };

  const remaining = Math.hypot(targetPoint.x - boat.pos.x, targetPoint.y - boat.pos.y);
  const heading = bearingDeg(boat.pos, targetPoint);
  const isLastLeg = boat.order.waypoints.length === 1;

  // The speed this leg can actually be flown at. The destination is worth slowing for; a
  // waypoint on the way is not (see the header).
  const reachable = maxApproachSpeed(
    remaining,
    headingDelta(boat.facing, heading),
    boat.stats.turnRate,
  );
  const notch = throttleSpeedFor(boat.stats, boat.throttle);
  const desired = isLastLeg ? Math.min(notch, reachable) : notch;

  const speed = approach(boat.speed, desired, MOVEMENT_ACCELERATION * dt);
  const facing = turnToward(boat.facing, heading, boat.stats.turnRate, dt);
  const step = speed * dt;

  // Reached this leg's waypoint. Pop it; if it was the last, the boat has arrived.
  if (step >= remaining) {
    const waypoints = boat.order.waypoints.slice(1);
    if (waypoints.length === 0)
      return { ...boat, pos: targetPoint, facing, speed: 0, order: HOLDING };
    return { ...boat, pos: targetPoint, facing, speed, order: { kind: 'transit', waypoints } };
  }

  // Going to be carried past this one instead. An intermediate waypoint counts as made good at
  // that point — the boat is as close to it as its turning circle will ever allow — and the next
  // leg takes over from where the boat is, this same tick, rather than after a wasted loop.
  if (!isLastLeg && speed > reachable) {
    const waypoints = boat.order.waypoints.slice(1);
    return stepBoat({ ...boat, order: { kind: 'transit', waypoints } }, dt);
  }

  return {
    ...boat,
    pos: {
      x: boat.pos.x + Math.cos((facing * Math.PI) / 180) * step,
      y: boat.pos.y + Math.sin((facing * Math.PI) / 180) * step,
    },
    facing,
    speed,
  };
}

function approach(value: number, target: number, maxDelta: number): number {
  if (value < target) return Math.min(value + maxDelta, target);
  return Math.max(value - maxDelta, target);
}

function bearingDeg(from: Vec2, to: Vec2): number {
  return normalizeDeg((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI);
}

function normalizeDeg(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** The short way round from `facing` to `heading`, in degrees: −180 (port) to +180 (starboard). */
function headingDelta(facing: number, heading: number): number {
  return ((heading - facing + 540) % 360) - 180;
}

/** Rotate `facing` toward `heading` by at most `turnRate·dt`, taking the short way round. */
function turnToward(facing: number, heading: number, turnRate: number, dt: number): number {
  const step = turnRate * dt;
  return normalizeDeg(facing + Math.max(-step, Math.min(step, headingDelta(facing, heading))));
}
