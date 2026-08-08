/**
 * Contour extraction — the carved field becomes the rock polygons everything else consumes.
 *
 * Marching squares at iso-zero, with the crossing on each lattice edge placed by linear
 * interpolation of the field. Because the field is a real distance rather than a 0/1
 * occupancy flag, that interpolation lands the vertex within a fraction of a cell of the
 * true boundary, and the walls come out curved.
 *
 * ## Orientation
 *
 * Every segment is emitted with **rock on its left**. That single rule fixes the winding of
 * everything downstream: chained together, a ring enclosing rock comes out counter-clockwise,
 * which is the positive orientation renderers and area tests expect. It also makes the case
 * table derivable rather than memorised — each case is "which way must I walk so the solid
 * corners stay on my left".
 *
 * ## Chaining is by edge identity, not by position
 *
 * A crossing lies on a specific lattice edge, and each edge is shared by exactly two cells,
 * so segments are linked by integer edge ids rather than by comparing coordinates. Matching
 * floating-point endpoints would be the usual source of a ring that fails to close on one
 * seed in five hundred; with ids it cannot happen.
 */

import type { ScalarField } from './carve.js';
import type { MapExtents, Obstacle, Vec2 } from './types.js';

/** Edge slots of a cell, in the order the case table names them. */
const BOTTOM = 0;
const RIGHT = 1;
const TOP = 2;
const LEFT = 3;

/**
 * Which edges each corner configuration connects, walking with rock on the left.
 *
 * Indexed by a 4-bit code: bit 0 is the bottom-left corner, then bottom-right, top-right,
 * top-left, set when that corner is rock. Cases 5 and 10 are the ambiguous saddles and are
 * resolved separately against the cell's centre value.
 */
const CASES: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  0: [],
  1: [[BOTTOM, LEFT]],
  2: [[RIGHT, BOTTOM]],
  3: [[RIGHT, LEFT]],
  4: [[TOP, RIGHT]],
  6: [[TOP, BOTTOM]],
  7: [[TOP, LEFT]],
  8: [[LEFT, TOP]],
  9: [[BOTTOM, TOP]],
  11: [[RIGHT, TOP]],
  12: [[LEFT, RIGHT]],
  13: [[BOTTOM, RIGHT]],
  14: [[LEFT, BOTTOM]],
  15: [],
};

/** Saddles, resolved by whether the cell's centre is rock: the two solid corners join or they do not. */
const SADDLE_5_JOINED: readonly (readonly [number, number])[] = [
  [BOTTOM, RIGHT],
  [TOP, LEFT],
];
const SADDLE_5_SPLIT: readonly (readonly [number, number])[] = [
  [BOTTOM, LEFT],
  [TOP, RIGHT],
];
const SADDLE_10_JOINED: readonly (readonly [number, number])[] = [
  [LEFT, BOTTOM],
  [RIGHT, TOP],
];
const SADDLE_10_SPLIT: readonly (readonly [number, number])[] = [
  [RIGHT, BOTTOM],
  [LEFT, TOP],
];

export interface ContourOptions {
  /** Douglas–Peucker tolerance, metres. */
  readonly simplifyTolerance: number;
  /** Rings enclosing less than this many square metres are dropped as specks. */
  readonly minArea: number;
}

/** Traces every rock outline in the field and returns them as clamped, simplified rings. */
export function extractObstacles(
  field: ScalarField,
  extents: MapExtents,
  options: ContourOptions,
): Obstacle[] {
  const { cols, rows } = field;
  const horizontalCount = (cols - 1) * rows;

  /** Where the contour crosses each lattice edge, by edge id. Filled as cells are visited. */
  const crossings = new Map<number, Vec2>();
  /** The segment leaving each edge, by edge id. One out-edge per crossing on a closed contour. */
  const next = new Map<number, number>();

  const isRock = (index: number) => (field.values[index] ?? 0) >= 0;

  for (let j = 0; j < rows - 1; j += 1) {
    for (let i = 0; i < cols - 1; i += 1) {
      const bl = j * cols + i;
      const br = bl + 1;
      const tl = bl + cols;
      const tr = tl + 1;

      let code = 0;
      if (isRock(bl)) code |= 1;
      if (isRock(br)) code |= 2;
      if (isRock(tr)) code |= 4;
      if (isRock(tl)) code |= 8;
      if (code === 0 || code === 15) continue;

      let segments = CASES[code];
      if (code === 5 || code === 10) {
        const centre =
          ((field.values[bl] ?? 0) +
            (field.values[br] ?? 0) +
            (field.values[tr] ?? 0) +
            (field.values[tl] ?? 0)) /
          4;
        const joined = centre >= 0;
        segments =
          code === 5
            ? joined
              ? SADDLE_5_JOINED
              : SADDLE_5_SPLIT
            : joined
              ? SADDLE_10_JOINED
              : SADDLE_10_SPLIT;
      }
      if (segments === undefined) continue;

      const edgeIds = [
        j * (cols - 1) + i, // bottom
        horizontalCount + j * cols + (i + 1), // right
        (j + 1) * (cols - 1) + i, // top
        horizontalCount + j * cols + i, // left
      ] as const;

      for (const [from, to] of segments) {
        ensureCrossing(field, crossings, edgeIds[from] ?? 0, from, i, j, horizontalCount);
        ensureCrossing(field, crossings, edgeIds[to] ?? 0, to, i, j, horizontalCount);
        next.set(edgeIds[from] ?? 0, edgeIds[to] ?? 0);
      }
    }
  }

  // ── chain the segments into rings ────────────────────────────────────────────
  const obstacles: Obstacle[] = [];
  const visited = new Set<number>();

  for (const start of next.keys()) {
    if (visited.has(start)) continue;

    const ring: Vec2[] = [];
    let edge: number | undefined = start;
    while (edge !== undefined && !visited.has(edge)) {
      visited.add(edge);
      const point = crossings.get(edge);
      if (point !== undefined) ring.push(point);
      edge = next.get(edge);
    }

    const finished = finishRing(ring, extents, options);
    if (finished !== null) obstacles.push(finished);
  }

  return obstacles;
}

/** Places the crossing on one lattice edge, if it has not already been placed. */
function ensureCrossing(
  field: ScalarField,
  crossings: Map<number, Vec2>,
  id: number,
  slot: number,
  i: number,
  j: number,
  horizontalCount: number,
): void {
  if (crossings.has(id)) return;

  const { cols, cellSize, originX, originY } = field;
  // Which two samples the edge spans, derived from the slot rather than from the id, so the
  // id scheme stays an implementation detail of this file.
  const horizontal = id < horizontalCount;
  const [ax, ay] =
    slot === BOTTOM ? [i, j] : slot === TOP ? [i, j + 1] : slot === LEFT ? [i, j] : [i + 1, j];
  const [bx, by] = horizontal ? [ax + 1, ay] : [ax, ay + 1];

  const fa = field.values[ay * cols + ax] ?? 0;
  const fb = field.values[by * cols + bx] ?? 0;
  // Where the field passes through zero between the two samples. The guard covers two equal
  // samples, which cannot straddle zero but would divide by it.
  const denominator = fb - fa;
  const t = denominator === 0 ? 0.5 : Math.min(1, Math.max(0, -fa / denominator));

  crossings.set(id, {
    x: originX + (ax + (bx - ax) * t) * cellSize,
    y: originY + (ay + (by - ay) * t) * cellSize,
  });
}

/** Clamps a traced ring into the map, simplifies it, and rejects it if it is a speck. */
function finishRing(ring: Vec2[], extents: MapExtents, options: ContourOptions): Obstacle | null {
  if (ring.length < 3) return null;

  // Rock that reaches the world's edge was traced just outside it (see carve.ts). Clamping
  // folds that excursion flat onto the frame, and the collinear run it leaves behind is
  // exactly what the simplifier removes next.
  const clamped = ring.map((point) => ({
    x: clamp(point.x, 0, extents.width),
    y: clamp(point.y, 0, extents.height),
  }));

  const simplified = simplifyRing(clamped, options.simplifyTolerance);
  if (simplified.length < 3) return null;
  if (Math.abs(signedArea(simplified)) < options.minArea) return null;

  // Rounded to a decimetre: far below any tolerance that matters, and it takes a visible bite
  // out of the JSON the map is shipped to clients as (planning/02 §6).
  return {
    vertices: simplified.map((point) => ({
      x: Math.round(point.x * 10) / 10,
      y: Math.round(point.y * 10) / 10,
    })),
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Twice the enclosed area, signed — positive counter-clockwise. */
function signedArea(ring: readonly Vec2[]): number {
  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a === undefined || b === undefined) continue;
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

/**
 * Douglas–Peucker over a closed ring.
 *
 * The ring is cut at its first vertex and at the vertex farthest from it, and the two halves
 * are simplified as open polylines. Cutting at two well-separated anchors rather than one
 * keeps the simplifier from flattening the ring's start, which a single cut does whenever the
 * first vertex happens to sit in the middle of a straight run.
 */
function simplifyRing(ring: readonly Vec2[], tolerance: number): Vec2[] {
  if (ring.length < 4 || tolerance <= 0) return [...ring];

  const first = ring[0];
  if (first === undefined) return [...ring];

  let farthest = 0;
  let farthestDistance = -1;
  for (let i = 1; i < ring.length; i += 1) {
    const point = ring[i];
    if (point === undefined) continue;
    const distance = (point.x - first.x) ** 2 + (point.y - first.y) ** 2;
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthest = i;
    }
  }

  const head = simplifyPath(ring.slice(0, farthest + 1), tolerance);
  const tail = simplifyPath([...ring.slice(farthest), first], tolerance);
  // Both halves carry the anchors they share, so the joins are dropped to avoid duplicates.
  return [...head.slice(0, -1), ...tail.slice(0, -1)];
}

function simplifyPath(path: readonly Vec2[], tolerance: number): Vec2[] {
  if (path.length < 3) return [...path];

  const start = path[0];
  const end = path[path.length - 1];
  if (start === undefined || end === undefined) return [...path];

  let index = 0;
  let worst = 0;
  for (let i = 1; i < path.length - 1; i += 1) {
    const point = path[i];
    if (point === undefined) continue;
    const distance = perpendicularDistance(point, start, end);
    if (distance > worst) {
      worst = distance;
      index = i;
    }
  }

  if (worst <= tolerance) return [start, end];

  const head = simplifyPath(path.slice(0, index + 1), tolerance);
  const tail = simplifyPath(path.slice(index), tolerance);
  return [...head.slice(0, -1), ...tail];
}

function perpendicularDistance(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);

  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}
