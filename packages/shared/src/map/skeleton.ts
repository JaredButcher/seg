/**
 * The route skeleton — where the cave's shape is actually decided.
 *
 * planning/14 §5 is emphatic that this comes first: *"Skeleton first, geometry second."* The
 * naive alternative is to generate noise and then check whether the result happens to be
 * playable, which has no bound on retries and produces maps whose structure is accidental.
 * Choosing the routes first makes the guarantees true by construction.
 *
 * ## Why the two width floors cannot be violated
 *
 * Free space is emitted as nothing but **discs**, every one of radius at least
 * `minPassageWidth / 2`. A union of discs of radius `r` has no opening narrower than `2r` —
 * there is no way to build one, because every point of free space lies inside some disc of
 * that radius. Nothing in this file ever puts rock back, so no later stage can pinch a
 * passage either. The trunk is the same argument with a bigger radius: its discs are laid
 * along one continuous polyline from the left edge to the right, so the widest end-to-end
 * route is at least `trunkPassageWidth` across, everywhere along it.
 *
 * That is the whole reason the pipeline is shaped this way, and it is why `measure.ts`
 * verifies the finished polygons independently rather than trusting this argument.
 *
 * ## The height budget
 *
 * The floors compete for a fixed amount of map height, and on a small map they can want more
 * than there is. The budget below resolves that by **dropping routes**, never by narrowing
 * one below its floor: a map with fewer ways through is a worse map, but a map with a 60 m
 * passage is a broken promise.
 */

import { createRng, createWander, type Rng } from '../math/rng.js';
import { MapGenerationError } from './generators.js';
import type { CaveTuning } from './tuning.js';
import type { MapExtents } from './types.js';

/** One carved disc of free space, in map metres. The only thing that ever removes rock. */
export interface Stamp {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/** One end-to-end route: its centreline as a function of x, and how wide it is. */
export interface Route {
  /** The route that carries the `trunkPassageWidth` guarantee. Exactly one per map. */
  readonly isTrunk: boolean;
  /** Passage width at its narrowest, in metres, before the carve margin. */
  readonly width: number;
  /** Centreline height at a horizontal position. Defined beyond the map edges, so the
   *  route runs off both ends rather than stopping at the frame. */
  yAt(x: number): number;
  /** Carve radius at a horizontal position, margin included. */
  rAt(x: number): number;
}

export interface Skeleton {
  readonly routes: readonly Route[];
  readonly stamps: readonly Stamp[];
}

/**
 * How much vertical space a route of this width occupies once width variation and the carve
 * margin are accounted for. Reserved up front, so neither can eat into the rock between
 * routes later.
 */
function reservedHeight(width: number, tuning: CaveTuning): number {
  return width * (1 + tuning.widthVariation) + 2 * tuning.geometryMargin;
}

/**
 * The most routes that fit at their floor widths, capped by what was asked for.
 *
 * Returns 0 when not even the trunk fits, which the caller turns into a typed error: a
 * tuning that cannot be satisfied on a given map size is a configuration mistake, and
 * silently producing a narrower trunk would defeat the point of having a floor.
 */
function routesThatFit(height: number, tuning: CaveTuning): number {
  const trunk = reservedHeight(tuning.trunkPassageWidth, tuning);
  const minor = reservedHeight(tuning.minPassageWidth, tuning);

  for (let n = tuning.routeCount; n >= 1; n -= 1) {
    const passages = trunk + (n - 1) * minor;
    const walls = (n + 1) * tuning.nominalWallThickness;
    if (passages + walls <= height) return n;
  }
  return 0;
}

/**
 * Lays out the routes across the map's height, then draws each one.
 *
 * The order is deliberate: settle how much height every route gets *before* any of them
 * wanders, so the wander amplitude can be sized against the walls that are actually there.
 * The walls are nominal rather than sacred — routes are meant to converge through them in
 * places — but they cannot be sized at all until the passages have been paid for.
 */
export function buildSkeleton(extents: MapExtents, tuning: CaveTuning, seed: number): Skeleton {
  if (tuning.trunkPassageWidth < tuning.minPassageWidth) {
    throw new MapGenerationError(
      'unsatisfiable_tuning',
      `trunkPassageWidth (${tuning.trunkPassageWidth} m) is narrower than minPassageWidth ` +
        `(${tuning.minPassageWidth} m), which is a contradiction`,
    );
  }

  const rng = createRng(seed);
  const { width, height } = extents;

  const count = routesThatFit(height, tuning);
  if (count === 0) {
    throw new MapGenerationError(
      'unsatisfiable_tuning',
      `a ${tuning.trunkPassageWidth} m trunk with ${tuning.nominalWallThickness} m walls does not ` +
        `fit in a ${height} m map`,
    );
  }

  // ── how wide each route gets ──────────────────────────────────────────────────
  //
  // Everything starts at its floor, which is known to fit, and the height left over is then
  // spent widening the minor routes toward the width the tuning asked for. Spending it this
  // way round means running out of room costs width, never a guarantee.
  const trunkIndex = rng.int(0, count - 1);
  const widths: number[] = [];
  for (let i = 0; i < count; i += 1) {
    widths.push(i === trunkIndex ? tuning.trunkPassageWidth : tuning.minPassageWidth);
  }

  const [wantMin, wantMax] = tuning.passageWidthRange;
  const targets = widths.map((_, i) =>
    i === trunkIndex
      ? tuning.trunkPassageWidth
      : Math.max(tuning.minPassageWidth, rng.range(wantMin, wantMax)),
  );

  const walls = (count + 1) * tuning.nominalWallThickness;
  const used = () => widths.reduce((sum, w) => sum + reservedHeight(w, tuning), 0);
  const totalSpare = Math.max(0, height - used() - walls);
  let widthBudget = totalSpare * tuning.spareToWidth;

  for (let i = 0; i < count && widthBudget > 0; i += 1) {
    if (i === trunkIndex) continue;
    const currentWidth = widths[i] ?? tuning.minPassageWidth;
    const target = targets[i] ?? currentWidth;
    // Converting spare height into passage width has to undo the reservation factor, or
    // widening by the raw spare would overspend by the variation allowance.
    const affordable = widthBudget / (1 + tuning.widthVariation);
    const grown = Math.min(target, currentWidth + affordable);
    widthBudget -= reservedHeight(grown, tuning) - reservedHeight(currentWidth, tuning);
    widths[i] = grown;
  }

  // Everything not spent on width — the share held back, plus whatever the routes could not
  // use — thickens every wall equally.
  const gap = (height - used()) / (count + 1);

  // Wander is measured against the wall, not against a surplus, which is what lets two
  // neighbours actually meet. At `wander = 1` a pair converging at their worst closes the
  // whole gap and the wall between them breaks; the passages merge into one wider space and
  // the slab either side becomes an island. That is the intended behaviour, and it is safe:
  // merging only ever widens water, and the floors are properties of the water.
  const wanderAmplitude = (tuning.wander * gap) / 2;

  // ── draw them ─────────────────────────────────────────────────────────────────
  const routes: Route[] = [];
  let cursor = gap;

  for (let i = 0; i < count; i += 1) {
    const routeWidth = widths[i] ?? tuning.minPassageWidth;
    const band = reservedHeight(routeWidth, tuning);
    const centreY = cursor + band / 2;
    cursor += band + gap;

    // Forked, and with a different salt per curve, so that changing one route's shape does
    // not reshuffle the next one's — and so a route's width does not follow its own height.
    const wander = createWander(rng.fork(i * 2 + 1), tuning.wanderDetail);
    const variation = createWander(rng.fork(i * 2 + 2), tuning.wanderDetail);

    const baseRadius = routeWidth / 2;
    const maxRadius = baseRadius * (1 + tuning.widthVariation) + tuning.geometryMargin;
    // The surface and the seabed are hard boundaries, so a route may wander into a wall
    // between passages but never into the frame. Clamping the centreline rather than the
    // amplitude keeps the bound exact at the widest point of the passage.
    const lowest = maxRadius + tuning.nominalWallThickness / 2;
    const highest = height - lowest;

    routes.push({
      isTrunk: i === trunkIndex,
      width: routeWidth,
      yAt: (x) => {
        const raw = centreY + wanderAmplitude * wander(x / width);
        return raw < lowest ? lowest : raw > highest ? highest : raw;
      },
      // Variation only ever widens: the floor is a floor, and the band already reserved room
      // for the widest this can get.
      rAt: (x) =>
        baseRadius * (1 + tuning.widthVariation * ((variation(x / width) + 1) / 2)) +
        tuning.geometryMargin,
    });
  }

  return { routes, stamps: stampSkeleton(routes, extents, tuning, rng) };
}

/** Walks every route, cross-link, and chamber, and turns them into discs. */
function stampSkeleton(
  routes: readonly Route[],
  extents: MapExtents,
  tuning: CaveTuning,
  rng: Rng,
): Stamp[] {
  const stamps: Stamp[] = [];
  const { width, height } = extents;

  for (const route of routes) {
    // Stepping by a fraction of the radius keeps consecutive discs overlapping enough that
    // the union is a smooth capsule rather than a string of beads.
    const step = Math.max(tuning.cellSize, route.width * 0.25);
    // Started and finished beyond the frame so the passage runs off both edges — a route
    // that stopped at x = 0 would leave a wall across its own mouth.
    const overhang = route.rAt(0) * 2;

    for (let x = -overhang; x <= width + overhang; x += step) {
      stamps.push({ x, y: route.yAt(x), r: route.rAt(x) });
    }
  }

  // ── chambers ──────────────────────────────────────────────────────────────────
  //
  // A local swelling of the passage rather than a room in its own right, and the main source
  // of variety between seeds. Bounded only by the frame: a chamber that grows into the wall
  // above it, or through it into the next passage, is doing the job — it turns a slab into
  // two islands and a junction, which is what a cave looks like and a pipe does not.
  const [scaleMin, scaleMax] = tuning.chamberWidthScale;
  const frameRock = tuning.nominalWallThickness / 2;
  const chamberCeiling = height * tuning.chamberMaxHeightShare;

  for (const route of routes) {
    for (let c = 0; c < tuning.chambersPerRoute; c += 1) {
      const x = rng.range(0, width);
      const y = route.yAt(x);
      const base = route.rAt(x);
      const room = Math.min(height - frameRock - y, y - frameRock, chamberCeiling);
      if (room <= base) continue;

      stamps.push({ x, y, r: Math.min(base * rng.range(scaleMin, scaleMax), room) });
    }
  }

  // ── cross-links ───────────────────────────────────────────────────────────────
  //
  // Vertical shafts joining neighbouring routes. These are what turn a set of parallel
  // tunnels into a network with choices in it — planning/14 §5 step 3. They only ever add
  // connectivity, so no invariant can be broken by adding more.
  const linkRadius = tuning.minPassageWidth / 2 + tuning.geometryMargin;

  for (let i = 0; i + 1 < routes.length; i += 1) {
    const lower = routes[i];
    const upper = routes[i + 1];
    if (lower === undefined || upper === undefined) continue;

    for (let k = 0; k < tuning.crossLinksPerGap; k += 1) {
      // Spread across the width with jitter, rather than uniformly random, so a gap never
      // happens to get all its links in the same place.
      const slot = (k + 0.5) / tuning.crossLinksPerGap;
      const x = width * (slot + rng.range(-0.3, 0.3) / tuning.crossLinksPerGap);
      const from = lower.yAt(x);
      const to = upper.yAt(x);

      // Half a radius per step. Discs a full radius apart still overlap, but their union
      // pinches to about 1.7× the radius at the waist between them — enough to clear the
      // floor, and enough narrower than the shaft's nominal width to be worth not doing.
      for (let y = from; y <= to; y += linkRadius / 2) {
        stamps.push({ x, y, r: linkRadius });
      }
      stamps.push({ x, y: to, r: linkRadius });
    }
  }

  return stamps;
}
