/**
 * Cave generation tuning — every number the Sparse and Dense generators derive from.
 *
 * This file is to the cave generators what `sizes.ts` is to map extents: the single place a
 * value is changed. planning/14 §5 calls the generator's parameters *content*, with the same
 * review requirements as the balance tables, which is the reason they live in one reviewable
 * table rather than scattered through the pipeline.
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
 * - **`trunkPassageWidth`** — at least one route crosses the whole map, left edge to right,
 *   without ever narrowing below this. There is always a way through for anything.
 *
 * Both are **floors, not targets**. Measured widths come out somewhat above them, because
 * carving adds `geometryMargin` to absorb the error that rasterizing and simplifying the
 * contour introduce. Asking for 100 m yields a narrowest passage of roughly 120 m; asking
 * for exactly 120 m of clearance means setting the floor lower and reading the measurement.
 *
 * ## A note on scale
 *
 * These openings are far wider than the passage classes in planning/14 §4, whose tightest
 * "Slot" is 16–28 m. A 100 m floor is four to six times that, and on a 1200 m-tall map it
 * changes what "dense" can mean: there is room for a handful of broad passages separated by
 * rock masses, not for a warren. That is a deliberate consequence of the floor, not an
 * oversight — see the note in `caves.ts` on what it costs.
 */

/** The map types that are generated as cave systems. `empty` is open water and has no tuning. */
export type CaveMapType = 'sparse' | 'dense';

export interface CaveTuning {
  /**
   * No opening anywhere in the map is narrower than this, in metres, measured across the
   * passage rather than from its centre. A hard floor — see the note above.
   */
  readonly minPassageWidth: number;

  /**
   * At least one left-to-right route never narrows below this, in metres. A hard floor.
   * Must be at least `minPassageWidth`; a smaller value would be a contradiction and is
   * rejected at generation.
   */
  readonly trunkPassageWidth: number;

  /**
   * How many end-to-end routes to carve, including the trunk. planning/14 I1 wants at least
   * three so a defender can never cover every approach.
   *
   * A ceiling rather than a promise: a small map may not have the height to fit this many at
   * the required widths, and the generator drops routes rather than violating a floor. What
   * it actually managed is on the returned map as `routeCount`.
   */
  readonly routeCount: number;

  /**
   * The width to aim for on non-trunk passages, in metres, sampled per route and then
   * trimmed to whatever the height budget allows. The lower bound is clamped up to
   * `minPassageWidth`.
   */
  readonly passageWidthRange: readonly [min: number, max: number];

  /**
   * The wall thickness the layout is planned around, in metres — between two passages, and
   * between a passage and the top or bottom of the map.
   *
   * **Nominal, not a floor.** It sets the spacing routes are stacked at and decides how many
   * fit, and then routes wander through it: where two converge the wall pinches, and where
   * they converge hard it breaks and the two passages merge. That is deliberate. A wall that
   * could never be breached produces the flat, evenly-stacked slabs a first pass at this
   * generator produced, which are correct and unplayable-looking. Breaching only ever widens
   * water, so no floor is at risk.
   *
   * The one place it does hold firm is the frame: a route's outer edge is kept clear of the
   * surface and the seabed, which are hard boundaries rather than terrain (planning/04 §6).
   */
  readonly nominalWallThickness: number;

  /**
   * How far a route wanders vertically, as a fraction of the nominal wall. Zero is a straight
   * tube; anything approaching 1 lets neighbouring routes meet and merge where they converge.
   *
   * This is the single biggest lever on whether a map reads as a cave system or as plumbing.
   */
  readonly wander: number;

  /**
   * What share of leftover height goes into widening passages rather than thickening rock,
   * 0..1.
   *
   * Spending all of it on width was the first version's mistake: the passages came out
   * generous, the walls came out at exactly their nominal thickness, and there was nothing
   * left for a route to wander through. Rock is scenery, cover, and the thing that makes a
   * route a choice — it deserves a share.
   */
  readonly spareToWidth: number;

  /** How many control points a route's wander curve has. Fewer means longer, lazier bends. */
  readonly wanderDetail: number;

  /**
   * How much a passage's width varies along its length, 0..1 of its own width. Widening
   * only — the floor is a floor — so this is reserved out of the height budget up front.
   */
  readonly widthVariation: number;

  /** Roughly how many chambers open off each route across the map's width. */
  readonly chambersPerRoute: number;

  /** A chamber's width as a multiple of its passage's, before clamping. */
  readonly chamberWidthScale: readonly [min: number, max: number];

  /**
   * A ceiling on chamber radius as a fraction of the map's height.
   *
   * Needed because chambers scale off their passage, and the trunk is 300 m wide on every map
   * size — on a small map a chamber two and a half times that is most of the world, and the
   * first version duly hollowed small maps out into open water. Scaling the ceiling to the
   * map keeps a chamber a feature of the map rather than a replacement for it.
   */
  readonly chamberMaxHeightShare: number;

  /** Vertical connectors carved between each neighbouring pair of routes. */
  readonly crossLinksPerGap: number;

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
 * Sparse: fewer, wider passages and big chambers (planning/14 §1.1).
 *
 * Reads as open water with cover rather than as a cave system. Sightlines are long, the
 * layer is often the only thing between two boats, and a Heavy is at home.
 */
const SPARSE: CaveTuning = {
  minPassageWidth: 100,
  trunkPassageWidth: 300,
  routeCount: 8,
  passageWidthRange: [160, 240],
  nominalWallThickness: 110,
  wander: 0.9,
  wanderDetail: 4,
  spareToWidth: 0.5,
  widthVariation: 0.25,
  chambersPerRoute: 8,
  chamberWidthScale: [1.6, 2.4],
  chamberMaxHeightShare: 0.08,
  crossLinksPerGap: 2,
  cellSize: 10,
  simplifyTolerance: 3,
  geometryMargin: 18,
};

/**
 * Dense: more routes, narrower, more turns and more cross-links.
 *
 * The same floors as Sparse — those are contracts, not flavour — spent on route count and
 * winding instead of on width. More ways through, less room in each, more rock to hide
 * behind and more corners to be surprised at.
 */
const DENSE: CaveTuning = {
  minPassageWidth: 100,
  trunkPassageWidth: 300,
  routeCount: 12,
  passageWidthRange: [110, 160],
  nominalWallThickness: 90,
  wander: 1.25,
  wanderDetail: 8,
  spareToWidth: 0.15,
  widthVariation: 0.35,
  chambersPerRoute: 6,
  chamberWidthScale: [1.5, 2.1],
  chamberMaxHeightShare: 0.068,
  crossLinksPerGap: 3,
  cellSize: 10,
  simplifyTolerance: 3,
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
