/**
 * Boats against each other — the test, and what it costs.
 *
 * Terrain is a hazard a player navigates; another boat is a *player*, so a collision between two
 * hulls is the only contact in the game where both sides did something. It therefore hurts, which
 * terrain (for now) does not: rock punishes you by stopping you, and a rammed boat punishes you by
 * being damaged, being loud about it, and being somewhere it did not choose to be.
 *
 * The damage is deliberately **minor** — a collision must never be a better weapon than a torpedo,
 * or the game acquires a degenerate opening move that costs nothing to try.
 */

import { getHull } from '../../content/hulls.js';
import type { Vec2 } from '../../map/types.js';
import type { BoatState } from '../../match/world.js';
import { hullOutline } from '../acoustics/boats.js';
import { polygonsOverlap } from './geometry.js';

/**
 * The closing speed below which a contact is harmless and silent, m/s.
 *
 * This is Q39's grazing threshold, and it applies to rock and to hulls alike: brushing a wall at
 * creep costs nothing, hitting one at flank does. Without it, cave navigation would be punishing
 * rather than tense — passages are the interesting water and a boat has to be able to use them.
 *
 * Two knots and a bit. Under the slow notch (5 kn ≈ 2.6 m/s), so a boat feeling its way along a
 * wall at the quietest speed it has is inside the threshold, which is exactly the manoeuvre the
 * threshold exists to permit.
 */
export const GRAZE_SPEED = 2;

/**
 * Hit points per m/s of closing speed, shared by both boats in a collision.
 *
 * Scaled so that the worst collision in the game — two boats at flank, bow to bow, about 30 m/s
 * of closing — takes roughly a quarter of a Light's hull and an eighth of a Heavy's. Enough to
 * matter, and to push a boat toward `DAMAGED_HP_FRACTION` where it becomes permanently loud
 * (planning/04 §8), while leaving ramming a bad idea rather than a tactic.
 */
export const COLLISION_DAMAGE_PER_MPS = 0.8;

/**
 * How hard two boats met, m/s.
 *
 * The magnitude of the *relative* velocity, not either boat's speed. Two boats in company at
 * flank that drift together have barely touched; the same two closing head-on have hit at twice
 * flank. Nothing else expresses both of those correctly, and using the faster boat's speed would
 * make a station-keeping screen a demolition derby.
 */
export function closingSpeed(a: BoatState, b: BoatState): number {
  const va = velocityOf(a);
  const vb = velocityOf(b);
  return Math.hypot(va.x - vb.x, va.y - vb.y);
}

/** Damage each boat takes from a contact at this closing speed. Zero for a graze. */
export function collisionDamage(closing: number): number {
  if (closing < GRAZE_SPEED) return 0;
  return closing * COLLISION_DAMAGE_PER_MPS;
}

/**
 * Whether two hulls are sharing water.
 *
 * Bounding circles first — half the hull's length about its centre, which contains the silhouette
 * whatever its pitch — and the exact outline test only for the pairs that survive. On a ten-boat
 * fleet that is forty-five cheap rejections and, almost always, no polygon work at all.
 *
 * A destroyed boat does not take part. A wreck is a reflector and a false contact (planning/04 §8)
 * and it sinks (`match/movement.ts#stepBoat`), but it is *not* yet a thing that occupies a
 * passage or can be run into — colliding with a hull on its way down to the seabed is a further
 * feature this is not, and hull-to-hull contact stays something only two live boats can have.
 */
export function hullsTouch(a: BoatState, b: BoatState): boolean {
  if (a.status === 'destroyed' || b.status === 'destroyed') return false;

  const reach = (getHull(a.hull).length + getHull(b.hull).length) / 2;
  if (Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) > reach) return false;

  return polygonsOverlap(
    hullOutline(getHull(a.hull), a.pos, a.facing),
    hullOutline(getHull(b.hull), b.pos, b.facing),
  );
}

function velocityOf(boat: BoatState): Vec2 {
  const radians = (boat.facing * Math.PI) / 180;
  return { x: Math.cos(radians) * boat.speed, y: Math.sin(radians) * boat.speed };
}
