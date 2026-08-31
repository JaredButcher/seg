/**
 * The polygon arithmetic collision is built out of — nothing about boats or rock in here.
 *
 * Separate from its two callers because both of them need it and neither should own it: the
 * terrain test asks "is any point of this outline inside stone", and the hull test asks "do these
 * two outlines overlap". Those are the same three routines seen from different sides.
 *
 * Everything is in map space, metres (`map/types.ts`), and everything is exact rather than
 * sampled — the sampling is `outlineSamples`, and it is a deliberate, documented choice made in
 * one place rather than an approximation smeared through the file.
 */

import type { Vec2 } from '../../map/types.js';

/**
 * An authored side profile placed in the world: mirrored if it is travelling left, pitched,
 * scaled, and moved onto `pos`.
 *
 * This is the **one** rule for turning a `content` outline into a polygon, and everything that
 * needs one goes through it: the acoustic model's reflector (`sim/acoustics/boats.ts`), the
 * collision shape, the proximity fuze, and the renderer's silhouette and hit test
 * (`client/render/silhouette.ts`). A hull that reflected sound off one shape and was drawn as
 * another is not a rendering discrepancy — the sonar picture *is* the game, so it would be two
 * different submarines.
 *
 * Two conversions, both easy to get backwards:
 *
 * - **The y flip.** Outlines are authored in simulation coordinates with `+y` down (planning/04
 *   §2); positions and `facing` live in the y-up map frame (`match/world.ts`). Without it every
 *   conning tower sits on the keel.
 * - **A boat travelling left is mirrored, not rotated.** Its facing sits in a band around 180°
 *   (planning/04 §5), and rotating the profile through that band rolls it upside down — which is
 *   what a submarine does not do, and what the acoustic skin used to reflect sound off. Mirroring
 *   in x and applying the pitch to the mirrored profile keeps the sail up. A weapon's pitch band
 *   is narrower still and reverses the same way (`match/movement.ts`), so the rule transfers to
 *   the weapon icons unchanged.
 *
 * `scale` is for the outlines authored at **unit length** — the weapon icons — and is the caller's
 * business: there is no size a weapon icon is naturally drawn at. A hull is authored in metres and
 * placed at 1.
 */
export function placeOutline(
  outline: readonly (readonly [number, number])[],
  pos: Vec2,
  facing: number,
  scale = 1,
): Vec2[] {
  // `cos(facing) < 0` is the left-travelling band. Exactly ±90° cannot happen — the pitch band is
  // far narrower than that — so the boundary needs no special case.
  const rightward = Math.cos((facing * Math.PI) / 180) >= 0;
  const radians = ((rightward ? facing : facing - 180) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const mirror = rightward ? scale : -scale;

  return outline.map(([ax, ay]) => {
    const lx = ax * mirror;
    const ly = -ay * scale;
    return { x: pos.x + lx * cos - ly * sin, y: pos.y + lx * sin + ly * cos };
  });
}

/**
 * Whether a point is inside a closed ring, by the even-odd rule.
 *
 * Half-open in `y`, exactly as `map/raster.ts` is and for the same reason: a vertex sitting
 * precisely on the test line must be counted once rather than twice, or a filled polygon
 * develops holes along every horizontal edge. A submarine silhouette is *full* of horizontal
 * edges — the hull's parallel sides are one — so this is the common case here, not the corner.
 *
 * Concave rings are handled; self-intersecting ones are not, and no hull is one.
 */
export function pointInPolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false;

  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (a === undefined || b === undefined) continue;
    if (a.y <= point.y === b.y <= point.y) continue;
    const crossing = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (crossing > point.x) inside = !inside;
  }

  return inside;
}

/**
 * Whether two segments properly cross.
 *
 * The orientation test, four cross products. Collinear overlap counts as *not* crossing: two
 * hulls sharing an edge exactly is a measure-zero case, and calling it a collision would mean a
 * boat that came to rest alongside another one being shoved off it forever.
 */
export function segmentsCross(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Whether two closed rings share any area.
 *
 * Both halves are needed and neither is redundant. Crossing edges catch the ordinary overlap;
 * containment catches the case where one outline sits *wholly* inside the other, which crosses
 * no edge at all — a Light swallowed by a Heavy, which at these hull sizes is a real geometry
 * rather than a pathological one.
 *
 * Exact, so there is no sampling density to get wrong. The cost is the edge loop, which is why
 * the caller gates it behind a bounding-circle test (`hulls.ts`).
 */
export function polygonsOverlap(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  const first = a[0];
  const other = b[0];
  if (first === undefined || other === undefined) return false;

  for (let i = 0; i < a.length; i += 1) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    if (a1 === undefined || a2 === undefined) continue;
    for (let j = 0; j < b.length; j += 1) {
      const b1 = b[j];
      const b2 = b[(j + 1) % b.length];
      if (b1 === undefined || b2 === undefined) continue;
      if (segmentsCross(a1, a2, b1, b2)) return true;
    }
  }

  return pointInPolygon(first, b) || pointInPolygon(other, a);
}

/**
 * How far a point is from a closed ring, in metres. Zero anywhere inside it.
 *
 * Added for detonation falloff, and the alternative it replaces is worth naming: measuring to a
 * hull's *centre* would mean a warhead against a Heavy's bow sat eighty-five metres from the
 * boat it had just hit, which with a forty-metre damage radius is a direct hit that does nothing
 * at all. A submarine is mostly length, so the distance that matters is the distance to the
 * steel.
 */
export function distanceToPolygon(point: Vec2, polygon: readonly Vec2[]): number {
  if (pointInPolygon(point, polygon)) return 0;

  let nearest = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (a === undefined || b === undefined) continue;
    nearest = Math.min(nearest, distanceToSegment(point, a, b));
  }
  return nearest;
}

/** Distance from a point to a line segment, clamped at both ends. */
export function distanceToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/**
 * Points along a closed ring's perimeter, no more than `spacing` metres apart, vertices included.
 *
 * This is how an outline is asked about a *raster* — the rock mask is cells, not polygons, so
 * there is nothing to intersect edges with and the outline has to be probed. Spacing at or below
 * the cell size is what makes that sound: a rock cell the outline crosses is at least one cell
 * wide, so a walk that never steps a full cell cannot step over it.
 *
 * Vertices are emitted whatever the spacing, because the extremes of a hull — the bow, the top of
 * the sail — are vertices, and they are the parts that touch a wall first.
 */
export function outlineSamples(outline: readonly Vec2[], spacing: number): readonly Vec2[] {
  const step = Math.max(spacing, 1e-3);
  const samples: Vec2[] = [];

  for (let i = 0; i < outline.length; i += 1) {
    const from = outline[i];
    const to = outline[(i + 1) % outline.length];
    if (from === undefined || to === undefined) continue;

    samples.push(from);

    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const divisions = Math.ceil(length / step);
    for (let k = 1; k < divisions; k += 1) {
      const t = k / divisions;
      samples.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
  }

  return samples;
}

/** Twice the signed area of the triangle `a b c`: positive when `c` is left of `a → b`. */
function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
