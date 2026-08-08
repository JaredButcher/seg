/**
 * Cave generation tuning — every number the Sparse and Dense generators derive from.
 *
 * This file is to the cave generators what `sizes.ts` is to map extents: the single place a
 * value is changed. planning/14 §5 calls the generator's parameters *content*, with the same
 * review requirements as the balance tables, which is the reason they live in one reviewable
 * table rather than scattered through the pipeline.
 *
 * ## The shape of a map
 *
 * A cave map is a stack of **levels** — broad horizontal galleries running the length of the
 * map — joined by **connections**, the vertical halls punched between neighbouring levels.
 * Both are deliberately large: a level is 200–1000 m tall and a connection 300–1200 m across,
 * on a base map 3000 m from seabed to surface. Three or four galleries with a handful of
 * cathedral-sized shafts between them, not a warren of tunnels.
 *
 * ## The two guarantees
 *
 * Two of these numbers are not tuning in the ordinary sense — they are contracts the
 * generator's output is measured against and rejected for breaking (see `measure.ts`):
 *
 * - **`minPassageWidth`** — nowhere in the carved map is there an opening narrower than this.
 *   Not "usually"; the free space is built as a union of discs of at least half this radius,
 *   so a narrower gap cannot be constructed, and the finished polygons are measured to prove
 *   it.
 * - **`trunkPassageWidth`** — at least one level crosses the whole map, left edge to right,
 *   without ever narrowing below this. There is always a way through for anything.
 *
 * Both are **floors, not targets**. Measured widths come out somewhat above them, because
 * carving adds `geometryMargin` to absorb the error that rasterizing and simplifying the
 * contour introduce.
 *
 * ## A note on scale
 *
 * These openings are far wider than the passage classes in planning/14 §4, whose tightest
 * "Slot" is 16–28 m. That is a deliberate departure: at the scale the scope actually reads,
 * a 30 m gap is a hairline and a fleet cannot manoeuvre in it. The consequence is that a map
 * is a small number of large spaces, and the variety has to come from their *shape* — level
 * heights that differ by a factor of three, connections that differ by a factor of four, and
 * the undulation and roughness below — rather than from their number.
 */

/** The map types that are generated as cave systems. `empty` is open water and has no tuning. */
export type CaveMapType = 'sparse' | 'dense';

export interface CaveTuning {
  /**
   * No opening anywhere in the map is narrower than this, in metres, measured across the
   * passage rather than from its centre. A hard floor — see the note above, and note that it
   * is also the floor of `levelHeightRange`: a level *is* an opening.
   */
  readonly minPassageWidth: number;

  /**
   * At least one left-to-right level never narrows below this, in metres. A hard floor.
   * Must be at least `minPassageWidth`; a smaller value would be a contradiction and is
   * rejected at generation.
   */
  readonly trunkPassageWidth: number;

  /**
   * How many levels to stack, including the trunk. planning/14 I1 wants at least three so a
   * defender can never cover every approach.
   *
   * A ceiling rather than a promise, and with levels this tall it is usually the height that
   * decides. The generator shortens the middling levels toward the floor before it drops any,
   * and never takes one below the floor; the shortest and the tallest are exempt from both, so
   * the spread survives whatever the budget does. What it actually managed is on the returned
   * map as `routeCount`.
   */
  readonly routeCount: number;

  /**
   * How tall a level may be, in metres — the vertical extent of the gallery, not its length.
   *
   * The single biggest lever on how a map reads. A map whose levels are all the same height
   * is a filing cabinet; one with a 250 m crawl under a 900 m cathedral has somewhere to hide
   * and somewhere to run. The lower bound is clamped up to `minPassageWidth`.
   */
  readonly levelHeightRange: readonly [min: number, max: number];

  /**
   * A ceiling on level height as a fraction of the map's height, applied on top of
   * `levelHeightRange`.
   *
   * The absolute range is written for the base map. On a Small map — 0.7× in both axes — a
   * 1000 m level would be half the world and there would be no room for a second one, so the
   * range contracts with the map rather than the level count collapsing to two.
   */
  readonly levelMaxHeightShare: number;

  /**
   * Where the "short" and "tall" bands sit inside `levelHeightRange`, as fractions of it.
   *
   * Every map is guaranteed one level drawn from below `shortLevelShare` and one from above
   * `tallLevelShare`, sampled before any of the others. That is what makes "at least one
   * shorter level and one taller level" true by construction rather than by luck of the draw.
   */
  readonly shortLevelShare: number;
  readonly tallLevelShare: number;

  /**
   * Exponent biasing the *unremarkable* levels — the ones that are neither the guaranteed
   * short nor the guaranteed tall — toward the bottom of the range. 1 is uniform; higher
   * values buy more levels by keeping most of them modest.
   */
  readonly levelHeightBias: number;

  /**
   * The wall thickness the layout is planned around, in metres — between two levels, and
   * between a level and the top or bottom of the map.
   *
   * **Nominal, not a floor.** It sets the spacing levels are stacked at and decides how many
   * fit, and then levels wander through it: where two converge the wall pinches, and where
   * they converge hard it breaks and the two galleries merge. That is deliberate. A wall that
   * could never be breached produces the flat, evenly-stacked slabs a first pass at this
   * generator produced, which are correct and unplayable-looking. Breaching only ever widens
   * water, so no floor is at risk.
   *
   * The one place it does hold firm is the frame: a level's outer edge is kept clear of the
   * surface and the seabed, which are hard boundaries rather than terrain (planning/04 §6).
   */
  readonly nominalWallThickness: number;

  /**
   * How far a level's centreline wanders vertically, as a fraction of the nominal wall. Zero
   * is a straight tube; anything approaching 1 lets neighbouring levels meet and merge where
   * they converge.
   */
  readonly wander: number;

  /** How many control points a level's wander curve has. Fewer means longer, lazier bends. */
  readonly wanderDetail: number;

  /**
   * A second, shorter-wavelength rise and fall on the centreline, as a fraction of the
   * level's own height.
   *
   * Distinct from `wander`, which is measured against the wall and decides whether two levels
   * meet. This is measured against the level and decides whether its floor rolls. Together
   * they give a gallery that both drifts across the map and heaves underfoot.
   */
  readonly undulation: number;
  readonly undulationDetail: number;

  /**
   * Fine, high-frequency swelling of the carve radius, as a fraction of it — the difference
   * between a smooth extruded tube and a rock face.
   *
   * Widening only, like `widthVariation`, because the floor is a floor. Reserved out of the
   * height budget up front so it cannot eat the wall above.
   */
  readonly roughness: number;
  readonly roughnessDetail: number;

  /**
   * How much a level's height varies along its length, 0..1 of its own height. Widening
   * only, and reserved out of the height budget up front.
   */
  readonly widthVariation: number;

  /** Roughly how many chambers open off each level across the map's width. */
  readonly chambersPerRoute: number;

  /** A chamber's radius as a multiple of its level's, before clamping. */
  readonly chamberWidthScale: readonly [min: number, max: number];

  /**
   * A ceiling on chamber radius as a fraction of the map's height. Keeps a chamber a feature
   * of the map rather than a replacement for it.
   */
  readonly chamberMaxHeightShare: number;

  /**
   * Bays cut into a level's floor or ceiling, per level, across the map's width.
   *
   * Where a chamber is centred on the centreline and swells the gallery symmetrically, an
   * alcove is offset to one side, so it bites into the rock above *or* below and leaves the
   * other face alone. That asymmetry is most of what stops a level reading as a tube.
   */
  readonly alcovesPerLevel: number;

  /** An alcove's radius as a multiple of its level's carve radius, before clamping. */
  readonly alcoveRadiusScale: readonly [min: number, max: number];

  /** Connections carved between each neighbouring pair of levels. */
  readonly crossLinksPerGap: number;

  /**
   * How wide a connection between two levels is, in metres. The absolute bounds: most land
   * above `connectionTypicalWidth`, and the extremes at either end are rare.
   */
  readonly connectionWidthRange: readonly [min: number, max: number];

  /** The width most connections clear. Below it is the exception, above it the rule. */
  readonly connectionTypicalWidth: number;

  /** How often a connection is drawn from the narrow band below `connectionTypicalWidth`. */
  readonly narrowConnectionChance: number;

  /**
   * Exponent biasing an ordinary connection's width toward `connectionTypicalWidth`. Higher
   * values make the cathedral-sized ones rarer without lowering the ceiling.
   */
  readonly connectionWidthBias: number;

  /** Carve/contour lattice spacing, in metres. Smaller is smoother, slower, and more vertices. */
  readonly cellSize: number;

  /** Douglas–Peucker tolerance for contour simplification, in metres. */
  readonly simplifyTolerance: number;

  /**
   * Added to every carved radius to absorb discretization: the lattice quantizes the
   * boundary by up to a cell, and simplification may move it by up to the tolerance. Without
   * it a passage carved at exactly the floor would measure a little under it.
   */
  readonly geometryMargin: number;
}

/**
 * Sparse: fewer, taller levels and big chambers (planning/14 §1.1).
 *
 * Reads as open water with cover rather than as a cave system. Sightlines are long, the
 * gallery floor is often the only thing between two boats, and a Heavy is at home.
 */
const SPARSE: CaveTuning = {
  minPassageWidth: 200,
  trunkPassageWidth: 400,
  routeCount: 6,
  levelHeightRange: [200, 1000],
  levelMaxHeightShare: 0.34,
  shortLevelShare: 0.14,
  tallLevelShare: 0.68,
  levelHeightBias: 1.6,
  nominalWallThickness: 120,
  wander: 1.1,
  wanderDetail: 4,
  undulation: 0.22,
  undulationDetail: 11,
  roughness: 0.09,
  roughnessDetail: 34,
  widthVariation: 0.18,
  chambersPerRoute: 5,
  chamberWidthScale: [1.3, 1.9],
  chamberMaxHeightShare: 0.24,
  alcovesPerLevel: 9,
  alcoveRadiusScale: [0.45, 0.9],
  crossLinksPerGap: 2,
  connectionWidthRange: [300, 1200],
  connectionTypicalWidth: 500,
  narrowConnectionChance: 0.18,
  connectionWidthBias: 2.6,
  cellSize: 10,
  simplifyTolerance: 1.5,
  geometryMargin: 18,
};

/**
 * Dense: more levels, shorter, more turns and more ways between them.
 *
 * The same floors and the same absolute ranges as Sparse — those are contracts and content
 * bounds, not flavour — spent on level count and winding instead of on height. A stronger
 * bias toward the bottom of the level range is what buys the extra galleries.
 */
const DENSE: CaveTuning = {
  minPassageWidth: 200,
  trunkPassageWidth: 400,
  routeCount: 8,
  levelHeightRange: [200, 1000],
  levelMaxHeightShare: 0.3,
  shortLevelShare: 0.12,
  tallLevelShare: 0.6,
  levelHeightBias: 2.6,
  nominalWallThickness: 100,
  wander: 1.35,
  wanderDetail: 7,
  undulation: 0.3,
  undulationDetail: 15,
  roughness: 0.12,
  roughnessDetail: 44,
  widthVariation: 0.22,
  chambersPerRoute: 5,
  chamberWidthScale: [1.2, 1.8],
  chamberMaxHeightShare: 0.18,
  alcovesPerLevel: 12,
  alcoveRadiusScale: [0.4, 0.85],
  crossLinksPerGap: 2,
  connectionWidthRange: [300, 1100],
  connectionTypicalWidth: 500,
  narrowConnectionChance: 0.28,
  connectionWidthBias: 3.2,
  cellSize: 10,
  simplifyTolerance: 1.5,
  geometryMargin: 18,
};

/** The shipped tuning for each cave map type. Changing a number here changes the content. */
export const CAVE_TUNING: Readonly<Record<CaveMapType, CaveTuning>> = {
  sparse: SPARSE,
  dense: DENSE,
};

/**
 * Applies an override on top of a type's shipped tuning.
 *
 * **Not for production.** The tuning is content: the server generates a map from a seed and
 * the shipped table, and a replay reproduces it from the seed and `generatorVersion` alone
 * (planning/04 §9). A map generated with an override cannot be reproduced from either, so
 * this exists for tests, the seed gallery, and tuning experiments — never for a lobby
 * setting or anything reachable from the wire.
 */
export function resolveTuning(type: CaveMapType, overrides?: Partial<CaveTuning>): CaveTuning {
  const base = CAVE_TUNING[type];
  return overrides === undefined ? base : { ...base, ...overrides };
}
