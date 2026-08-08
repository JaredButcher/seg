/**
 * The level skeleton — where the cave's shape is actually decided.
 *
 * planning/14 §5 is emphatic that this comes first: *"Skeleton first, geometry second."* The
 * naive alternative is to generate noise and then check whether the result happens to be
 * playable, which has no bound on retries and produces maps whose structure is accidental.
 * Choosing the levels first makes the guarantees true by construction.
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
 * Every addition below — chambers, alcoves, connections, the roughness on the carve radius —
 * respects that one rule and nothing else. It is why the fine detail can be as wild as it
 * likes without endangering anything.
 *
 * ## The height budget
 *
 * Levels are tall — 200 to 1000 m against a 3000 m base map — so only a handful fit and the
 * budget is the thing that decides how many. It is spent in this order:
 *
 * 1. Draw a height for every level the tuning asked for, guaranteeing one short and one tall.
 * 2. Squeeze the levels *between* those two toward the floor until the stack fits.
 * 3. If it still does not fit, drop the least characterful survivor and try again.
 * 4. Give whatever is left over to the walls.
 *
 * Squeezing before dropping is deliberate. Four galleries of which two sit at the floor is a
 * better map than two galleries with room to spare — planning/14 I1 wants at least three ways
 * through — and neither step ever takes a level below the floor, because a map with fewer ways
 * through is a worse map but a map with a 60 m passage is a broken promise. The shortest and
 * the tallest are exempt from both: they are the spread the map is promised to have.
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

/** One end-to-end level: its centreline as a function of x, and how tall it is. */
export interface Route {
  /** The level that carries the `trunkPassageWidth` guarantee. Exactly one per map. */
  readonly isTrunk: boolean;
  /** The level's height at its narrowest, in metres, before the carve margin. */
  readonly width: number;
  /** Centreline height at a horizontal position. Defined beyond the map edges, so the
   *  level runs off both ends rather than stopping at the frame. */
  yAt(x: number): number;
  /** Carve radius at a horizontal position, margin included. */
  rAt(x: number): number;
}

export interface Skeleton {
  readonly routes: readonly Route[];
  readonly stamps: readonly Stamp[];
}

/**
 * How much vertical space a level of this height occupies once every widening effect and the
 * carve margin are accounted for. Reserved up front, so none of them can eat into the rock
 * between levels later.
 */
function reservedHeight(levelHeight: number, tuning: CaveTuning): number {
  return levelHeight * (1 + tuning.widthVariation + tuning.roughness) + 2 * tuning.geometryMargin;
}

/** The inverse: the tallest level whose reservation fits in `room` metres. */
function levelHeightWithin(room: number, tuning: CaveTuning): number {
  return (room - 2 * tuning.geometryMargin) / (1 + tuning.widthVariation + tuning.roughness);
}

/**
 * The range a level's height is drawn from on a map this tall.
 *
 * The absolute range in the tuning is written for the base map; `levelMaxHeightShare` pulls
 * the ceiling down on a smaller one so the tall level does not eat the whole world. The
 * trunk floor is honoured on top of that, because a ceiling below it would make the trunk
 * guarantee unsatisfiable by arithmetic rather than by anything about the map.
 */
function levelHeightBounds(mapHeight: number, tuning: CaveTuning): readonly [number, number] {
  const [low, high] = tuning.levelHeightRange;
  const floor = Math.max(tuning.minPassageWidth, low);
  const capped = Math.min(high, mapHeight * tuning.levelMaxHeightShare);
  return [floor, Math.max(floor, tuning.trunkPassageWidth, capped)];
}

/**
 * Which survivor to drop when the stack does not fit.
 *
 * The one nearest the middle of the current spread — the level whose absence changes the map
 * least. The shortest and the tallest are protected while three remain, because they are the
 * two the map is promised to have.
 */
function leastCharacterful(levels: readonly number[]): number {
  const low = Math.min(...levels);
  const high = Math.max(...levels);
  const middle = (low + high) / 2;

  let victim = -1;
  let closest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < levels.length; i += 1) {
    const height = levels[i] ?? 0;
    if (levels.length > 2 && (height === low || height === high)) continue;
    const distance = Math.abs(height - middle);
    if (distance < closest) {
      closest = distance;
      victim = i;
    }
  }
  // Everything is protected only when every level is the same height, in which case any of
  // them will do.
  return victim === -1 ? levels.length - 1 : victim;
}

/**
 * Squeezes the ordinary levels toward the floor until the stack fits, or reports that it
 * cannot.
 *
 * The shortest and the tallest are held at the heights they were drawn at — they are the
 * promise the map makes — and everything between them gives ground first. Reserved height is
 * affine in level height, so the shrink factor is one division rather than a search.
 *
 * Returns `null` when even the ordinary levels flat on the floor leave the stack too tall,
 * which is the caller's signal to drop one.
 */
function squeezeToFit(
  levels: readonly number[],
  floor: number,
  mapHeight: number,
  tuning: CaveTuning,
): number[] | null {
  const shortest = levels.indexOf(Math.min(...levels));
  const tallest = levels.lastIndexOf(Math.max(...levels));
  const ordinary = (i: number) => i !== shortest && i !== tallest;

  let fixed = (levels.length + 1) * tuning.nominalWallThickness;
  let slope = 0;
  for (let i = 0; i < levels.length; i += 1) {
    const height = levels[i] ?? floor;
    fixed += reservedHeight(ordinary(i) ? floor : height, tuning);
    if (ordinary(i)) slope += reservedHeight(height, tuning) - reservedHeight(floor, tuning);
  }

  if (fixed > mapHeight) return null;
  const room = slope === 0 ? 1 : Math.min(1, (mapHeight - fixed) / slope);

  return levels.map((height, i) => (ordinary(i) ? floor + (height - floor) * room : height));
}

/** Draws the level heights for one map, then fits the stack to what the map can hold. */
function planLevels(mapHeight: number, tuning: CaveTuning, rng: Rng): number[] {
  const [floor, ceiling] = levelHeightBounds(mapHeight, tuning);
  const span = ceiling - floor;
  const wanted = Math.max(1, Math.floor(tuning.routeCount));

  // The two characterful levels are drawn first, so they are in the set whatever the count —
  // and, being the extremes, they are the two the fit protects.
  const levels: number[] = [rng.range(floor, floor + span * tuning.shortLevelShare)];
  if (wanted > 1) {
    levels.push(
      Math.max(tuning.trunkPassageWidth, rng.range(floor + span * tuning.tallLevelShare, ceiling)),
    );
  }
  while (levels.length < wanted) {
    levels.push(floor + span * Math.pow(rng.next(), tuning.levelHeightBias));
  }

  // Squeeze first, drop second. A map with four galleries of which two are at the floor is a
  // better map than one with two galleries and room to spare, and the pair that carries the
  // spread survives either way.
  let kept = levels;
  for (;;) {
    const fitted = squeezeToFit(kept, floor, mapHeight, tuning);
    if (fitted !== null) return fitted;
    if (kept.length <= 1) break;
    kept = kept.filter((_, i) => i !== leastCharacterful(kept));
  }

  // One level left and still too tall for the map: it is shortened rather than dropped. The
  // trunk check in `buildSkeleton` is what makes what comes back here still legal.
  return [levelHeightWithin(mapHeight - 2 * tuning.nominalWallThickness, tuning)];
}

/** Fisher–Yates on the generator's own stream, so the stacking order is seeded like the rest. */
function shuffle(values: number[], rng: Rng): void {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    const a = values[i] ?? 0;
    const b = values[j] ?? 0;
    values[i] = b;
    values[j] = a;
  }
}

/**
 * Lays the levels out across the map's height, then draws each one.
 *
 * The order is deliberate: settle how much height every level gets *before* any of them
 * wanders, so the wander amplitude can be sized against the walls that are actually there.
 * The walls are nominal rather than sacred — levels are meant to converge through them in
 * places — but they cannot be sized at all until the galleries have been paid for.
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

  // The one thing that cannot be traded away. Checked before anything is drawn, so a tuning
  // that cannot be satisfied on this map size fails as a configuration mistake rather than
  // quietly producing a narrower trunk.
  if (reservedHeight(tuning.trunkPassageWidth, tuning) + 2 * tuning.nominalWallThickness > height) {
    throw new MapGenerationError(
      'unsatisfiable_tuning',
      `a ${tuning.trunkPassageWidth} m trunk with ${tuning.nominalWallThickness} m walls does not ` +
        `fit in a ${height} m map`,
    );
  }

  const levels = planLevels(height, tuning, rng);
  shuffle(levels, rng);

  // The tallest level carries the trunk. It is guaranteed to clear the trunk floor: the tall
  // draw is clamped up to it, and the trim protects the tallest survivor.
  let trunkIndex = 0;
  for (let i = 1; i < levels.length; i += 1) {
    if ((levels[i] ?? 0) > (levels[trunkIndex] ?? 0)) trunkIndex = i;
  }

  // Everything the levels did not claim thickens every wall equally.
  const claimed = levels.reduce((sum, h) => sum + reservedHeight(h, tuning), 0);
  const gap = (height - claimed) / (levels.length + 1);

  // Wander is measured against the wall, not against a surplus, which is what lets two
  // neighbours actually meet. At `wander = 1` a pair converging at their worst closes the
  // whole gap and the wall between them breaks; the galleries merge into one wider space and
  // the slab either side becomes an island. That is the intended behaviour, and it is safe:
  // merging only ever widens water, and the floors are properties of the water.
  const wanderAmplitude = (tuning.wander * gap) / 2;

  // ── draw them ─────────────────────────────────────────────────────────────────
  const routes: Route[] = [];
  let cursor = gap;

  for (let i = 0; i < levels.length; i += 1) {
    const levelHeight = levels[i] ?? tuning.minPassageWidth;
    const band = reservedHeight(levelHeight, tuning);
    const centreY = cursor + band / 2;
    cursor += band + gap;

    // Forked, and with a different salt per curve, so that changing one level's shape does
    // not reshuffle the next one's — and so a level's height does not follow its own drift.
    const drift = createWander(rng.fork(i * 4 + 1), tuning.wanderDetail);
    const swell = createWander(rng.fork(i * 4 + 2), tuning.wanderDetail);
    const roll = createWander(rng.fork(i * 4 + 3), tuning.undulationDetail);
    const rough = createWander(rng.fork(i * 4 + 4), tuning.roughnessDetail);

    const baseRadius = levelHeight / 2;
    const maxRadius =
      baseRadius * (1 + tuning.widthVariation + tuning.roughness) + tuning.geometryMargin;
    // The surface and the seabed are hard boundaries, so a level may wander into a wall
    // between galleries but never into the frame. Clamping the centreline rather than the
    // amplitude keeps the bound exact at the widest point of the gallery.
    const lowest = maxRadius + tuning.nominalWallThickness / 2;
    const highest = height - lowest;
    // Undulation is measured against the level itself rather than against the wall, so a
    // tall gallery heaves more than a crawlspace does.
    const rollAmplitude = (tuning.undulation * levelHeight) / 2;

    routes.push({
      isTrunk: i === trunkIndex,
      width: levelHeight,
      yAt: (x) => {
        const t = x / width;
        const raw = centreY + wanderAmplitude * drift(t) + rollAmplitude * roll(t);
        return raw < lowest ? lowest : raw > highest ? highest : raw;
      },
      // Both modulations only ever widen: the floor is a floor, and the band already reserved
      // room for the widest the two together can get.
      rAt: (x) => {
        const t = x / width;
        const swollen = tuning.widthVariation * ((swell(t) + 1) / 2);
        const roughened = tuning.roughness * ((rough(t) + 1) / 2);
        return baseRadius * (1 + swollen + roughened) + tuning.geometryMargin;
      },
    });
  }

  return { routes, stamps: stampSkeleton(routes, extents, tuning, rng) };
}

/** Walks every level, chamber, alcove, and connection, and turns them into discs. */
function stampSkeleton(
  routes: readonly Route[],
  extents: MapExtents,
  tuning: CaveTuning,
  rng: Rng,
): Stamp[] {
  const stamps: Stamp[] = [];
  const { width, height } = extents;

  /** The smallest disc anything here may emit. Below it the opening floor is at risk. */
  const minRadius = tuning.minPassageWidth / 2 + tuning.geometryMargin;
  /** How much rock the frame keeps for itself. */
  const frameRock = tuning.nominalWallThickness / 2;

  for (const route of routes) {
    // Stepping by a fraction of the radius keeps consecutive discs overlapping enough that
    // the union is a smooth capsule rather than a string of beads.
    const step = Math.max(tuning.cellSize, route.width * 0.25);
    // Started and finished beyond the frame so the gallery runs off both edges — a level
    // that stopped at x = 0 would leave a wall across its own mouth.
    const overhang = route.rAt(0) * 2;

    /*
     * Stepped along the centreline, not along x.
     *
     * The waist between two discs of radius `r` whose centres are `d` apart is
     * `2·√(r² − d²/4)`, so it collapses as `d` approaches `2r`. Advancing by `step` in x and
     * ignoring how far the level *rose* in between makes `d` the hypotenuse rather than the
     * step: on a steep stretch a 25 m step with a 125 m climb puts the centres 127 m apart,
     * and two 136 m passages meet in a 49 m neck — under the floor the whole construction
     * exists to guarantee.
     *
     * Subdividing until each advance is at most `step` in both axes keeps `d ≤ step·√2`,
     * which holds the waist comfortably above the floor. It matters far more now that
     * undulation puts a second, shorter wavelength on the centreline.
     */
    let previousX = -overhang;
    let previousY = route.yAt(previousX);
    stamps.push({ x: previousX, y: previousY, r: route.rAt(previousX) });

    for (let x = -overhang + step; x <= width + overhang; x += step) {
      const y = route.yAt(x);
      const substeps = Math.max(1, Math.ceil(Math.abs(y - previousY) / step));
      for (let k = 1; k <= substeps; k += 1) {
        const at = previousX + (x - previousX) * (k / substeps);
        stamps.push({ x: at, y: route.yAt(at), r: route.rAt(at) });
      }
      previousX = x;
      previousY = y;
    }
  }

  /*
   * Everything that is not the levels themselves, kept apart so the membrane pass can treat
   * each as the single disc it is rather than re-walking the centrelines it already covers.
   */
  const features: Stamp[] = [];

  // ── chambers ──────────────────────────────────────────────────────────────────
  //
  // A local swelling of the gallery rather than a room in its own right. Bounded only by the
  // frame: a chamber that grows into the wall above it, or through it into the next level, is
  // doing the job — it turns a slab into two islands and a junction, which is what a cave
  // looks like and a pipe does not.
  const [scaleMin, scaleMax] = tuning.chamberWidthScale;
  const chamberCeiling = height * tuning.chamberMaxHeightShare;

  for (const route of routes) {
    for (let c = 0; c < tuning.chambersPerRoute; c += 1) {
      const x = rng.range(0, width);
      const y = route.yAt(x);
      const base = route.rAt(x);
      const room = Math.min(height - frameRock - y, y - frameRock, chamberCeiling);
      if (room <= base) continue;

      features.push({ x, y, r: Math.min(base * rng.range(scaleMin, scaleMax), room) });
    }
  }

  // ── alcoves ───────────────────────────────────────────────────────────────────
  //
  // The same idea pushed off the centreline. A chamber swells a gallery symmetrically and
  // leaves it reading as a wider gallery; an alcove bites into the floor *or* the ceiling and
  // leaves the other face where it was, which is the asymmetry that stops a level looking
  // extruded. Offset by three-quarters of the carve radius, so it always overlaps its own
  // gallery and never becomes a sealed pocket.
  const [alcoveMin, alcoveMax] = tuning.alcoveRadiusScale;

  for (const route of routes) {
    for (let a = 0; a < tuning.alcovesPerLevel; a += 1) {
      const x = rng.range(0, width);
      const base = route.rAt(x);
      const centre = route.yAt(x);
      const radius = Math.max(
        minRadius,
        Math.min(base * rng.range(alcoveMin, alcoveMax), chamberCeiling),
      );

      const lowest = radius + frameRock;
      const highest = height - radius - frameRock;
      if (lowest > highest) continue;

      const wanted = centre + (rng.chance(0.5) ? 1 : -1) * base * 0.75;
      const y = wanted < lowest ? lowest : wanted > highest ? highest : wanted;
      // Clamping against the frame can shove an alcove clean off its own gallery on a level
      // that is already hard against the seabed. Better none than a sealed pocket.
      if (Math.abs(y - centre) >= base + radius) continue;

      features.push({ x, y, r: radius });
    }
  }

  // ── connections ───────────────────────────────────────────────────────────────
  //
  // The vertical halls joining neighbouring levels. These are what turn a stack of galleries
  // into a network with choices in it — planning/14 §5 step 3 — and at 300 to 1200 m across
  // they are structure in their own right rather than plumbing between the real spaces. They
  // only ever add connectivity, so no invariant can be broken by making them bigger.
  const [linkMin, linkMax] = tuning.connectionWidthRange;
  const typical = Math.min(Math.max(tuning.connectionTypicalWidth, linkMin), linkMax);
  /** A shaft cannot be wider than the map has room for between the seabed and the surface. */
  const linkCeiling = (height - 2 * frameRock) / 2;

  for (let i = 0; i + 1 < routes.length; i += 1) {
    const lower = routes[i];
    const upper = routes[i + 1];
    if (lower === undefined || upper === undefined) continue;

    for (let k = 0; k < tuning.crossLinksPerGap; k += 1) {
      // Spread across the width with jitter, rather than uniformly random, so a gap never
      // happens to get all its links in the same place — and staggered half a slot from one
      // gap to the next, so climbing the map is a zig-zag rather than a lift shaft, and so two
      // shafts in neighbouring gaps can never end up side by side with a hairline between them.
      const slot = (k + 0.25 + (i % 2) * 0.5) / tuning.crossLinksPerGap;
      const x = width * (slot + rng.range(-0.2, 0.2) / tuning.crossLinksPerGap);

      // Most connections clear the typical width, the narrow band is the exception, and the
      // biggest are rare rather than merely possible.
      const drawn = rng.chance(tuning.narrowConnectionChance)
        ? rng.range(linkMin, typical)
        : typical + (linkMax - typical) * Math.pow(rng.next(), tuning.connectionWidthBias);
      const radius = Math.max(minRadius, Math.min(drawn / 2 + tuning.geometryMargin, linkCeiling));

      const lowest = radius + frameRock;
      const highest = height - radius - frameRock;
      const hold = (y: number) =>
        lowest > highest ? height / 2 : y < lowest ? lowest : y > highest ? highest : y;

      const from = hold(lower.yAt(x));
      const to = hold(upper.yAt(x));
      const bottom = Math.min(from, to);
      const top = Math.max(from, to);

      // Half a radius per step. Discs a full radius apart still overlap, but their union
      // pinches at the waist between them — enough narrower than the shaft's nominal width
      // to be worth not doing.
      for (let y = bottom; y <= top; y += radius / 2) {
        features.push({ x, y, r: radius });
      }
      features.push({ x, y: top, r: radius });
    }
  }

  stamps.push(...features, ...breachMembranes(routes, features, extents, tuning));
  return stamps;
}

/**
 * Punches through every rock membrane thinner than the passage floor.
 *
 * ## The hairline
 *
 * Everything above only ever adds water, which is what makes the passage floor safe against
 * anything happening *inside* a space. It says nothing about the space *between* two of them,
 * and that is where the floor was actually being broken.
 *
 * Picture a gallery whose ceiling bulges — roughness, undulation, the width variation — and
 * just crests through the wall into the gallery above. The two waters are now joined, but
 * they are joined through a slot as wide as the crest is long, which near the moment of
 * breakthrough is a few metres. Rock tapers to a wedge on either side of it and the channel
 * between the two wedge tips is a hairline: water narrower than the floor, built entirely out
 * of discs that each honour it. The same thing happens under a shaft that stops just short of
 * the level above, and under a chamber that swells to just touch its neighbour.
 *
 * ## The rule
 *
 * A membrane is either thick rock or a proper opening — never a razor.
 *
 * Wherever two structures come within `minPassageWidth` of each other, a disc at least the
 * floor across is stamped between them. Where they had not met, that opens a real passage;
 * where they had just met, it widens the slot they met through to the full floor. Sampled
 * closer together than the disc is wide, so the coverage along a membrane is continuous.
 *
 * It only ever adds water, so it cannot endanger anything the earlier stages guaranteed, and
 * it is the reason the generator's self-check passes on every seed rather than on most of
 * them.
 */
function breachMembranes(
  routes: readonly Route[],
  stamps: readonly Stamp[],
  extents: MapExtents,
  tuning: CaveTuning,
): Stamp[] {
  const { width, height } = extents;
  const breaches: Stamp[] = [];

  const minRadius = tuning.minPassageWidth / 2 + tuning.geometryMargin;
  const frameRock = tuning.nominalWallThickness / 2;
  const thin = tuning.minPassageWidth;

  /**
   * How much rock lies between two vertical spans, negative where they overlap. Whichever
   * way round they happen to be: levels wander past one another, so "above" is a local fact
   * rather than a property of the stacking order.
   */
  const membrane = (aLow: number, aHigh: number, bLow: number, bHigh: number): number =>
    Math.max(bLow - aHigh, aLow - bHigh);

  const cut = (x: number, low: number, high: number, gap: number): void => {
    const radius = Math.max(minRadius, Math.abs(gap) / 2 + tuning.geometryMargin);
    const lowest = radius + frameRock;
    const highest = height - radius - frameRock;
    if (lowest > highest) return;

    const wanted = (low + high) / 2;
    breaches.push({
      x,
      y: wanted < lowest ? lowest : wanted > highest ? highest : wanted,
      r: radius,
    });
  };

  // ── level against level ───────────────────────────────────────────────────────
  //
  // Walked along the map rather than per stamp, because this is the case that runs for
  // kilometres and the samples have to be evenly spaced to cover it.
  const step = minRadius / 2;

  for (let i = 0; i < routes.length; i += 1) {
    for (let j = i + 1; j < routes.length; j += 1) {
      const lower = routes[i];
      const upper = routes[j];
      if (lower === undefined || upper === undefined) continue;

      for (let x = 0; x <= width; x += step) {
        const a = lower.yAt(x);
        const ar = lower.rAt(x);
        const b = upper.yAt(x);
        const br = upper.rAt(x);
        const gap = membrane(a - ar, a + ar, b - br, b + br);
        if (gap >= thin || gap <= -thin) continue;

        cut(x, Math.min(a + ar, b + br), Math.max(a - ar, b - br), gap);
      }
    }
  }

  // ── everything else against the levels ────────────────────────────────────────
  //
  // Chambers, alcoves, and the discs a shaft is built from. Each is a single disc, so it is
  // enough to ask what the levels are doing at its own x — a chamber sits on its own level
  // and reads as deep overlap there, and it is the *other* levels it might be grazing.
  for (const stamp of stamps) {
    for (const route of routes) {
      const y = route.yAt(stamp.x);
      const r = route.rAt(stamp.x);
      const gap = membrane(stamp.y - stamp.r, stamp.y + stamp.r, y - r, y + r);
      if (gap >= thin || gap <= -thin) continue;

      cut(stamp.x, Math.min(stamp.y + stamp.r, y + r), Math.max(stamp.y - stamp.r, y - r), gap);
    }
  }

  return breaches;
}
