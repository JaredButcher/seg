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
