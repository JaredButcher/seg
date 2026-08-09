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

/** Advance one boat by `dt` seconds. `hold` and destroyed boats do not move. */
export function stepBoat(boat: BoatState, dt: number): BoatState {
  if (boat.status === 'destroyed' || boat.order.kind !== 'transit') return boat;

  const targetPoint = boat.order.waypoints[0];
  if (targetPoint === undefined) return { ...boat, speed: 0, order: HOLDING };

  const desired = throttleSpeedFor(boat.stats, boat.throttle);
  const speed = approach(boat.speed, desired, MOVEMENT_ACCELERATION * dt);
  const facing = turnToward(
    boat.facing,
    bearingDeg(boat.pos, targetPoint),
    boat.stats.turnRate,
    dt,
  );

  const step = speed * dt;
  const remaining = Math.hypot(targetPoint.x - boat.pos.x, targetPoint.y - boat.pos.y);

  // Reached this leg's waypoint. Pop it; if it was the last, the boat has arrived.
  if (step >= remaining) {
    const waypoints = boat.order.waypoints.slice(1);
    if (waypoints.length === 0)
      return { ...boat, pos: targetPoint, facing, speed: 0, order: HOLDING };
    return { ...boat, pos: targetPoint, facing, speed, order: { kind: 'transit', waypoints } };
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

/** Rotate `facing` toward `heading` by at most `turnRate·dt`, taking the short way round. */
function turnToward(facing: number, heading: number, turnRate: number, dt: number): number {
  const delta = ((heading - facing + 540) % 360) - 180;
  const step = turnRate * dt;
  return normalizeDeg(facing + Math.max(-step, Math.min(step, delta)));
}
