/**
 * @seg/client/render/silhouette — placing a hull's side profile in the world.
 *
 * The polygon is authored once in `content/hulls.ts` and does four jobs (planning/09 §11): the
 * fleet editor's elevation drawing, the scope's own-forces layer, the shape the acoustic model
 * reflects sound off, and now the silhouette a confirmed hostile contact is drawn as. This is
 * the placement, shared by the two that draw it on the scope, because a contact and a friendly
 * that were mirrored by different code would eventually be mirrored differently.
 *
 * Two conversions, both easy to get backwards:
 *
 * - **The y flip.** Silhouettes are authored in simulation coordinates with `+y` down
 *   (planning/04 §2); the world container is y-up. Drawing one unflipped puts every conning
 *   tower on the keel.
 * - **A boat travelling left is mirrored, not rotated.** Its facing sits in a band around 180°
 *   (planning/04 §5), and rotating the profile through that band would roll it upside down.
 *   Mirroring in x and then applying the pitch keeps the sail up, which is what a submarine does.
 *
 * Placement is `placeSilhouette`, and everything else here is a consumer of it — the drawing and
 * the **hit test** most of all. Clicking a boat picks it (planning/08 §5), so the shape the
 * player aims at has to be the shape they can see; a pick target derived independently of the
 * outline would be a hull that selects from a place it visibly is not.
 */

import { getHull, type HullId, type Vec2 } from '@seg/shared';
import type { Graphics } from 'pixi.js';

/**
 * A hull's outline in world metres, at a position and pitch — or `null` for a hull with no
 * polygon, which the content tables do not produce but the type allows.
 */
export function placeSilhouette(hull: HullId, pos: Vec2, facing: number): readonly Vec2[] | null {
  const { silhouette } = getHull(hull);
  if (silhouette.length === 0) return null;

  // `cos(facing) < 0` is the left-travelling band. Exactly ±90° cannot happen — the pitch band
  // is far narrower than that — so the boundary needs no special case.
  const rightward = Math.cos((facing * Math.PI) / 180) >= 0;
  const radians = ((rightward ? facing : facing - 180) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const mirror = rightward ? 1 : -1;

  return silhouette.map(([vx, vy]) => {
    const lx = vx * mirror;
    const ly = -vy;
    return { x: pos.x + lx * cos - ly * sin, y: pos.y + lx * sin + ly * cos };
  });
}

/** Lay a hull's outline into a graphics context as a closed path, in map metres. */
export function traceSilhouette(
  graphics: Graphics,
  hull: HullId,
  pos: Vec2,
  facing: number,
): boolean {
  const outline = placeSilhouette(hull, pos, facing);
  const [first, ...rest] = outline ?? [];
  if (first === undefined) return false;

  graphics.moveTo(first.x, first.y);
  for (const point of rest) graphics.lineTo(point.x, point.y);
  graphics.closePath();
  return true;
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
