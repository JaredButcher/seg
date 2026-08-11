/**
 * @seg/client/render/silhouette — placing an authored side profile in the world.
 *
 * A hull's polygon is authored once in `content/hulls.ts` and does four jobs (planning/09 §11):
 * the fleet editor's elevation drawing, the scope's own-forces layer, the shape the acoustic
 * model reflects sound off, and the silhouette a confirmed hostile contact is drawn as. This is
 * the placement, shared by the two that draw it on the scope, because a contact and a friendly
 * that were mirrored by different code would eventually be mirrored differently.
 *
 * Weapons have their own polygons in `content/weapons.ts` and go through the same placement,
 * with one extra step: theirs are authored at **unit length** and scaled by the caller, because
 * a friendly weapon is drawn at a floor size in screen pixels and a hostile one at a fixed forty
 * metres. Everything else about the two is identical, which is the reason they share a file —
 * the drone's dome is exactly the sort of asymmetric feature that a second, subtly different
 * mirror rule would eventually put on the wrong side.
 *
 * Two conversions, both easy to get backwards:
 *
 * - **The y flip.** Outlines are authored in simulation coordinates with `+y` down
 *   (planning/04 §2); the world container is y-up. Drawing one unflipped puts every conning
 *   tower on the keel.
 * - **A boat travelling left is mirrored, not rotated.** Its facing sits in a band around 180°
 *   (planning/04 §5), and rotating the profile through that band would roll it upside down.
 *   Mirroring in x and then applying the pitch keeps the sail up, which is what a submarine does.
 *   A weapon's pitch band is narrower still and it reverses the same way (`match/movement.ts`),
 *   so the rule transfers unchanged.
 *
 * Placement is `placeOutline`, and everything else here is a consumer of it — the drawing and
 * the **hit test** most of all. Clicking a boat picks it (planning/08 §5), so the shape the
 * player aims at has to be the shape they can see; a pick target derived independently of the
 * outline would be a hull that selects from a place it visibly is not.
 */

import {
  getHull,
  getWeapon,
  TORPEDO_LENGTH,
  type HullId,
  type Vec2,
  type WeaponId,
} from '@seg/shared';
import type { Graphics } from 'pixi.js';

/** An authored outline, as the content tables hold one: `[x, y]` pairs, `+y` down. */
type Outline = readonly (readonly [number, number])[];

/**
 * An authored outline placed in the world: mirrored if it is travelling left, pitched, scaled,
 * and moved onto `pos`. `null` for an empty polygon, which the content tables do not produce but
 * the types allow.
 */
export function placeOutline(
  outline: Outline,
  pos: Vec2,
  facing: number,
  scale = 1,
): readonly Vec2[] | null {
  if (outline.length === 0) return null;

  // `cos(facing) < 0` is the left-travelling band. Exactly ±90° cannot happen — the pitch band
  // is far narrower than that — so the boundary needs no special case.
  const rightward = Math.cos((facing * Math.PI) / 180) >= 0;
  const radians = ((rightward ? facing : facing - 180) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const mirror = rightward ? scale : -scale;

  return outline.map(([vx, vy]) => {
    const lx = vx * mirror;
    const ly = -vy * scale;
    return { x: pos.x + lx * cos - ly * sin, y: pos.y + lx * sin + ly * cos };
  });
}

/**
 * A hull's outline in world metres, at a position and pitch. Unscaled: a hull is authored in
 * metres and drawn at the size it is.
 */
export function placeSilhouette(hull: HullId, pos: Vec2, facing: number): readonly Vec2[] | null {
  return placeOutline(getHull(hull).silhouette, pos, facing);
}

/**
 * A weapon's icon in world metres, at a position, pitch, and drawn length.
 *
 * `length` is not a fudge factor — the polygon is authored at unit length precisely so that the
 * caller supplies it (`content/weapons.ts#WeaponDef.silhouette`). There is no size a weapon icon
 * is naturally drawn at: the friendly one has a floor in screen pixels and the hostile one is a
 * fixed distance in the water, and neither is seven metres.
 */
export function placeWeaponIcon(
  weapon: WeaponId,
  pos: Vec2,
  facing: number,
  length: number,
): readonly Vec2[] | null {
  return placeOutline(getWeapon(weapon).silhouette, pos, facing, length);
}

/** Lay a placed outline into a graphics context as a closed path. */
function trace(graphics: Graphics, outline: readonly Vec2[] | null): boolean {
  const [first, ...rest] = outline ?? [];
  if (first === undefined) return false;

  graphics.moveTo(first.x, first.y);
  for (const point of rest) graphics.lineTo(point.x, point.y);
  graphics.closePath();
  return true;
}

/** Lay a hull's outline into a graphics context as a closed path, in map metres. */
export function traceSilhouette(
  graphics: Graphics,
  hull: HullId,
  pos: Vec2,
  facing: number,
): boolean {
  return trace(graphics, placeSilhouette(hull, pos, facing));
}

/** The same, for a weapon's icon at a given drawn length. See `placeWeaponIcon`. */
export function traceWeaponIcon(
  graphics: Graphics,
  weapon: WeaponId,
  pos: Vec2,
  facing: number,
  length: number,
): boolean {
  return trace(graphics, placeWeaponIcon(weapon, pos, facing, length));
}

// ── How big a weapon is drawn ───────────────────────────────────────────────────────
//
// Both rules live here rather than beside the two layers that draw them, because what matters
// about them is the relationship: **a hostile weapon's mark is always the larger of the two**.
// Split across two files that is an invariant nobody is holding, and it is exactly the kind that
// breaks silently — it holds at the zoom a developer happens to be sitting at and inverts at the
// far end of the range, which is where a player pulls out to when they are trying to find the
// thing that is about to kill them.

/**
 * The smallest a **friendly** weapon is drawn, CSS pixels.
 *
 * A torpedo is seven metres long and a Heavy is a hundred and seventy, so at any zoom where the
 * boat is legible the weapon is a third of a pixel — and this is the object whose position the
 * player most needs to read. The floor makes it honest about its length up close and a symbol as
 * the camera pulls out, the same bargain the mini-map's chart marks make.
 */
export const FRIENDLY_WEAPON_MIN_PX = 9;

/** The size a **hostile** weapon's mark holds while the zoom allows it, map metres. */
export const CONTACT_MARK_M = 40;

/**
 * The smallest a hostile weapon's mark is drawn, CSS pixels. Above `FRIENDLY_WEAPON_MIN_PX` on
 * purpose — see the section header.
 */
export const CONTACT_MARK_MIN_PX = 15;

/** How long one of the player's own weapons is drawn, map metres, at `scale` px per metre. */
export function friendlyWeaponLength(scale: number): number {
  return Math.max(TORPEDO_LENGTH, FRIENDLY_WEAPON_MIN_PX / scale);
}

/**
 * How long a confirmed hostile weapon's mark is drawn, map metres — identified or not, so
 * classifying one changes its shape and nothing else. A mark that resized on the same frame would
 * read as the weapon having got closer.
 *
 * **Fixed in world metres, with a floor in screen pixels**, and the two halves answer different
 * objections.
 *
 * Fixed in metres is the default because a hostile contact is a *measurement*: inflating it as
 * the camera pulls out would be the display claiming more precision about where it is than the
 * sonar has. `CONTACT_MARK_M` is six times a real torpedo, and that gap is deliberate too — at
 * seven metres the mark would be invisible beside a hundred-and-seventy-metre hull on the same
 * screen, and the two have to be comparable because the player is deciding which to worry about.
 *
 * The floor exists because the friendly icon has one, and without a matching one the sizes invert
 * at the far end of the zoom range: pulled out to the whole of a large map, nine screen pixels is
 * well over forty metres, so the player's own weapons would be drawn *larger* than the enemy's.
 */
export function contactMarkLength(scale: number): number {
  return Math.max(CONTACT_MARK_M, CONTACT_MARK_MIN_PX / scale);
}

/**
 * Whether a world point is on a boat, `slop` metres of tolerance either way.
 *
 * The tolerance is what makes the test usable at every zoom: zoomed out to the whole map a
 * Light is a couple of pixels of hull, and a click that had to land inside those pixels would
 * be a control the player cannot operate. The caller converts a fixed number of screen pixels
 * into metres, so the target is a constant size *on screen* rather than in the water.
 *
 * Inside the outline, or within `slop` of one of its edges. The edge distance rather than the
 * distance to the centre, because a hull is seventy metres of boat and four of sail: a disc big
 * enough to cover the bow would swallow the water above the conning tower as well.
 */
export function silhouetteHit(
  hull: HullId,
  pos: Vec2,
  facing: number,
  point: Vec2,
  slop: number,
): boolean {
  const outline = placeSilhouette(hull, pos, facing);
  if (outline === null) return false;
  if (containsPoint(outline, point)) return true;
  return distanceToOutline(outline, point) <= slop;
}

/** The closed outline's edges, each as its two ends. The last vertex joins the first. */
function* edges(outline: readonly Vec2[]): Generator<readonly [Vec2, Vec2]> {
  let previous = outline[outline.length - 1];
  if (previous === undefined) return;
  for (const vertex of outline) {
    yield [previous, vertex];
    previous = vertex;
  }
}

/** Even-odd ray cast along `+x`: an odd number of crossings means the point is enclosed. */
function containsPoint(outline: readonly Vec2[], point: Vec2): boolean {
  let inside = false;
  for (const [a, b] of edges(outline)) {
    if (a.y > point.y === b.y > point.y) continue;
    if (point.x < ((a.x - b.x) * (point.y - b.y)) / (a.y - b.y) + b.x) inside = !inside;
  }
  return inside;
}

function distanceToOutline(outline: readonly Vec2[], point: Vec2): number {
  let nearest = Infinity;
  for (const [a, b] of edges(outline)) nearest = Math.min(nearest, distanceToSegment(point, a, b));
  return nearest;
}

function distanceToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}
