/**
 * How a weapon in the water moves — planning/04 §1 step 5, the kinematics half.
 *
 * Pure, one torpedo, one tick, like `match/movement.ts` is for boats and for the same reason: a
 * replay reproduces a match from its command log (04 §9), and a step that wandered would corrupt
 * every replay that touched it.
 *
 * ## It is a simpler boat
 *
 * No throttle, no orders, no waypoint queue — a torpedo accelerates to its one speed and steers
 * at one point. What it has that a boat does not is a **pitch band it obeys**: planning/04 §5
 * describes the band for submarines and the movement phase does not implement it yet, but for
 * torpedoes the band *is* the balance dimension (05 §4), so it is here from the start.
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

import { TORPEDO_ACCELERATION, getWeapon } from '../../content/weapons.js';
import type { Vec2 } from '../../map/types.js';
import { turningRadius, type TorpedoState } from '../../match/torpedo.js';

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
  return distance <= Math.max(step, turningRadius(torpedo.weapon));
}

/**
 * Advance one weapon by `dt` seconds, steering at `steerTo` — or holding its course when that is
 * `null`, which is what an unguided weapon past its aim point does.
 *
 * Speed, facing, position, and the fuel counter, and nothing else: the fuze, the seeker, and the
 * phase transitions are the phase's business (`phase.ts`). Keeping them apart is what makes this
 * testable by asking "where is it after two seconds" with no map and no fleet.
 */
export function stepTorpedo(torpedo: TorpedoState, steerTo: Vec2 | null, dt: number): TorpedoState {
  const def = getWeapon(torpedo.weapon);

  const speed = Math.min(def.speed, torpedo.speed + TORPEDO_ACCELERATION * dt);
  const facing =
    steerTo === null
      ? torpedo.facing
      : turnToward(
          torpedo.facing,
          clampPitch(bearingDeg(torpedo.pos, steerTo), def.maxPitch),
          def.turnRate,
          dt,
        );

  const step = speed * dt;
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
