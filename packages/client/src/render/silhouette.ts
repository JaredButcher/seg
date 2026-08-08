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
 */

import { getHull, type HullId, type Vec2 } from '@seg/shared';
import type { Graphics } from 'pixi.js';

/** Lay a hull's outline into a graphics context as a closed path, in map metres. */
export function traceSilhouette(
  graphics: Graphics,
  hull: HullId,
  pos: Vec2,
  facing: number,
): boolean {
  const { silhouette } = getHull(hull);
  const [first, ...rest] = silhouette;
  if (first === undefined) return false;

  // `cos(facing) < 0` is the left-travelling band. Exactly ±90° cannot happen — the pitch band
  // is far narrower than that — so the boundary needs no special case.
  const rightward = Math.cos((facing * Math.PI) / 180) >= 0;
  const radians = ((rightward ? facing : facing - 180) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const mirror = rightward ? 1 : -1;

  const place = ([vx, vy]: readonly [number, number]): Vec2 => {
    const lx = vx * mirror;
    const ly = -vy;
    return { x: pos.x + lx * cos - ly * sin, y: pos.y + lx * sin + ly * cos };
  };

  const start = place(first);
  graphics.moveTo(start.x, start.y);
  for (const vertex of rest) {
    const point = place(vertex);
    graphics.lineTo(point.x, point.y);
  }
  graphics.closePath();
  return true;
}
