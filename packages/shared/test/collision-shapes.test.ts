/**
 * The shapes collision is decided on: the polygon arithmetic, the rock mask, and the hull-against-
 * hull test.
 *
 * These are the primitives; `collision-phase` is what the runtime does with them. Split for the
 * same reason the acoustics suites are — a failure here is a geometry bug, and a failure there is a
 * rule bug, and telling them apart from the test name is worth two files.
 */

import {
  closingSpeed,
  collisionDamage,
  getHull,
  GRAZE_SPEED,
  HOLDING,
  hullOutline,
  hullsTouch,
  outlineSamples,
  pointInPolygon,
  polygonsOverlap,
  TerrainCollider,
  type BoatState,
  type MapExtents,
  type Obstacle,
  type Vec2,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

const EXTENTS: MapExtents = { width: 1000, height: 1000 };

/** A vertical wall filling the map's height between two x values. */
function wall(x0: number, x1: number): Obstacle {
  return {
    vertices: [
      { x: x0, y: 0 },
      { x: x1, y: 0 },
      { x: x1, y: 1000 },
      { x: x0, y: 1000 },
    ],
  };
}

const SQUARE: readonly Vec2[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

function boat(overrides: Partial<BoatState> = {}): BoatState {
  const hull = getHull(overrides.hull ?? 'medium');
  return {
    id: 1,
    team: 'team1',
    owner: 'a1',
    index: 0,
    name: 'S-01',
    hull: hull.id,
    stats: hull.stats,
    cost: hull.cost,
    weaponSubstitutions: {},
    pos: { x: 500, y: 500 },
    facing: 0,
    speed: 0,
    throttle: 'slow',
    hp: hull.stats.maxHp,
    tubes: [],
    order: HOLDING,
    status: 'active',
    activeSonar: false,
    lastPingTick: 0,
    transients: [],
    ...overrides,
  };
}

describe('placing an authored outline', () => {
  const CENTRE: Vec2 = { x: 500, y: 500 };
  /** The highest point of a placed hull, relative to its centre: the top of the sail. */
  const sail = (outline: readonly Vec2[]): number =>
    Math.max(...outline.map((vertex) => vertex.y)) - CENTRE.y;

  it('mirrors a boat travelling left rather than rotating it', () => {
    // The bug this pins: `hullOutline` used to rotate the profile through the whole of `facing`,
    // so a boat in the band around 180° (planning/04 §5) presented a silhouette rolled upside
    // down — sail on the keel — to the acoustic skin, the collision test, and the fuze, while the
    // renderer mirrored the same polygon and drew it the right way up. The sonar picture *is* the
    // game, so that is not a cosmetic disagreement: the squares a left-facing hull lit were the
    // shape of a boat nobody was looking at.
    const right = hullOutline(getHull('medium'), CENTRE, 0);
    const left = hullOutline(getHull('medium'), CENTRE, 180);

    expect(left).toHaveLength(right.length);
    for (let i = 0; i < right.length; i += 1) {
      const there = right[i]!;
      const back = left[i]!;
      // Mirrored in x about the boat's own centre, and untouched in y. Rotation would have
      // negated both.
      expect(back.x).toBeCloseTo(2 * CENTRE.x - there.x, 6);
      expect(back.y).toBeCloseTo(there.y, 6);
    }

    // With teeth: the hull has to be asymmetric about its centreline for any of the above to
    // mean anything, and the sail has to end up on the same side of it either way.
    expect(sail(right)).toBeGreaterThan(0);
    expect(sail(left)).toBeCloseTo(sail(right), 6);
  });

  it('keeps the sail up through the pitch band at both ends of the compass', () => {
    // The mirror composes with the pitch rather than replacing it: a boat pitched five degrees is
    // five degrees off level whichever way it is travelling, and still the right way up.
    const hull = getHull('heavy');
    for (const pitch of [5, -5]) {
      const right = hullOutline(hull, CENTRE, pitch);
      const left = hullOutline(hull, CENTRE, 180 - pitch);
      expect(sail(right)).toBeGreaterThan(0);
      expect(sail(left)).toBeCloseTo(sail(right), 6);
      // And it really is pointing the other way: the bow crosses the centre.
      expect(right[0]!.x).toBeGreaterThan(CENTRE.x);
      expect(left[0]!.x).toBeLessThan(CENTRE.x);
    }
  });
});

describe('pointInPolygon', () => {
  it('separates inside from outside', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, SQUARE)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, SQUARE)).toBe(false);
    expect(pointInPolygon({ x: 5, y: -1 }, SQUARE)).toBe(false);
  });

  it('does not leave a hole along a horizontal edge', () => {
    // The half-open rule earns its keep here. A submarine silhouette is mostly horizontal edges —
    // the parallel sides of the pressure hull are one long pair — so a double-counted vertex would
    // punch a line of "outside" straight down the middle of every boat in the game.
    expect(pointInPolygon({ x: 5, y: 0 }, SQUARE)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 10 }, SQUARE)).toBe(false);
  });

  it('handles a concave ring', () => {
    // An L, with the notch in the top-right quadrant.
    const ell: readonly Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon({ x: 2, y: 8 }, ell)).toBe(true);
    expect(pointInPolygon({ x: 8, y: 2 }, ell)).toBe(true);
    expect(pointInPolygon({ x: 8, y: 8 }, ell)).toBe(false);
  });
});

describe('polygonsOverlap', () => {
  const shifted = (dx: number, dy: number): readonly Vec2[] =>
    SQUARE.map((v) => ({ x: v.x + dx, y: v.y + dy }));

  it('finds an ordinary overlap and rejects a miss', () => {
    expect(polygonsOverlap(SQUARE, shifted(5, 5))).toBe(true);
    expect(polygonsOverlap(SQUARE, shifted(20, 0))).toBe(false);
  });

  it('finds one polygon wholly inside another, which crosses no edge at all', () => {
    const small: readonly Vec2[] = [
      { x: 3, y: 3 },
      { x: 7, y: 3 },
      { x: 7, y: 7 },
      { x: 3, y: 7 },
    ];
    expect(polygonsOverlap(SQUARE, small)).toBe(true);
    expect(polygonsOverlap(small, SQUARE)).toBe(true);
  });

  it('finds a crossing where neither polygon holds a vertex of the other', () => {
    // A tall thin bar through a wide flat one. Every vertex of each is outside the other, so only
    // the edge test can see this — which is exactly the case a vertex-sampling test would miss.
    const flat: readonly Vec2[] = [
      { x: -10, y: 4 },
      { x: 20, y: 4 },
      { x: 20, y: 6 },
      { x: -10, y: 6 },
    ];
    const tall: readonly Vec2[] = [
      { x: 4, y: -10 },
      { x: 6, y: -10 },
      { x: 6, y: 20 },
      { x: 4, y: 20 },
    ];
    expect(polygonsOverlap(flat, tall)).toBe(true);
  });
});

describe('outlineSamples', () => {
  it('keeps every vertex and never steps further than the spacing', () => {
    const samples = outlineSamples(SQUARE, 3);

    for (const vertex of SQUARE) {
      expect(samples.some((s) => s.x === vertex.x && s.y === vertex.y)).toBe(true);
    }
    for (let i = 0; i < samples.length; i += 1) {
      const a = samples[i];
      const b = samples[(i + 1) % samples.length];
      if (a === undefined || b === undefined) continue;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(3 + 1e-9);
    }
  });

  it('emits the vertices even when the spacing is larger than the shape', () => {
    expect(outlineSamples(SQUARE, 1000)).toHaveLength(SQUARE.length);
  });
});

describe('TerrainCollider', () => {
  const collider = new TerrainCollider(EXTENTS, [wall(200, 400)]);

  it('knows stone from water', () => {
    expect(collider.isRock(300, 500)).toBe(true);
    expect(collider.isRock(100, 500)).toBe(false);
    expect(collider.isRock(600, 500)).toBe(false);
  });

  it('treats everything off the map as solid, so the arena has a floor and a ceiling', () => {
    expect(collider.isRock(-1, 500)).toBe(true);
    expect(collider.isRock(500, -1)).toBe(true);
    expect(collider.isRock(500, 1001)).toBe(true);
    expect(collider.isRock(1001, 500)).toBe(true);
  });

  it('agrees with the map ruler about where the wall is', () => {
    // Both rasterize through `map/raster.ts`; this is the assertion that keeps them honest, because
    // a boat stopped by a wall its own sonar says is not there is the failure that would follow.
    expect(collider.isRock(199, 500)).toBe(false);
    expect(collider.isRock(201, 500)).toBe(true);
  });

  it('catches a bow inside the wall while the boat’s centre is still in water', () => {
    const medium = getHull('medium');
    // 140 m long, so the bow reaches 70 m ahead. At x = 150 the centre is 50 m clear of the wall
    // and the bow is 20 m inside it — the whole reason the outline is tested and not the position.
    expect(collider.hits(medium, { x: 150, y: 500 }, 0)).toBe(true);
    expect(collider.isRock(150, 500)).toBe(false);
    expect(collider.hits(medium, { x: 100, y: 500 }, 0)).toBe(false);
  });

  it('lets a boat turned away from the wall sit where a boat pointed at it could not', () => {
    const medium = getHull('medium');
    // Same position, stern-on. The hull occupies different water at a different heading, which is
    // what makes a pinned boat able to turn its way out.
    expect(collider.hits(medium, { x: 150, y: 500 }, 0)).toBe(true);
    expect(collider.hits(medium, { x: 150, y: 500 }, 90)).toBe(false);
  });

  it('reads a boat wherever it currently is', () => {
    expect(collider.hitsBoat(boat({ pos: { x: 300, y: 500 } }))).toBe(true);
    expect(collider.hitsBoat(boat({ pos: { x: 700, y: 500 } }))).toBe(false);
  });
});

describe('hullsTouch', () => {
  it('rejects boats that are nowhere near each other without looking at their outlines', () => {
    expect(hullsTouch(boat(), boat({ id: 2, pos: { x: 700, y: 500 } }))).toBe(false);
  });

  it('finds two hulls bow to bow', () => {
    const a = boat({ pos: { x: 500, y: 500 }, facing: 0 });
    const b = boat({ id: 2, pos: { x: 560, y: 500 }, facing: 180 });
    expect(hullsTouch(a, b)).toBe(true);
    // ...and the outlines really are the shape being compared, not a circle around them.
    expect(
      polygonsOverlap(
        hullOutline(getHull('medium'), a.pos, a.facing),
        hullOutline(getHull('medium'), b.pos, b.facing),
      ),
    ).toBe(true);
  });

  it('lets two hulls pass abeam of each other at a distance a bounding circle would reject', () => {
    // 60 m apart vertically, which is inside the 140 m bounding reach and nowhere near the 11 m of
    // hull. A circle-only test would call this a collision every time boats moved in company.
    expect(hullsTouch(boat(), boat({ id: 2, pos: { x: 500, y: 560 } }))).toBe(false);
  });

  it('ignores a wreck, which is not yet a thing that occupies water', () => {
    const wreck = boat({ id: 2, pos: { x: 560, y: 500 }, facing: 180, status: 'destroyed' });
    expect(hullsTouch(boat(), wreck)).toBe(false);
  });
});

describe('how hard two boats met', () => {
  it('measures the relative velocity, not either boat’s speed', () => {
    const headOn = closingSpeed(
      boat({ facing: 0, speed: 5 }),
      boat({ id: 2, facing: 180, speed: 5 }),
    );
    expect(headOn).toBeCloseTo(10);

    // In company at the same speed and heading: they have barely touched, whatever the speedo says.
    const company = closingSpeed(
      boat({ facing: 0, speed: 12 }),
      boat({ id: 2, facing: 0, speed: 12 }),
    );
    expect(company).toBeCloseTo(0);
  });

  it('charges nothing for a graze and rises linearly above it', () => {
    expect(collisionDamage(GRAZE_SPEED - 0.01)).toBe(0);
    expect(collisionDamage(GRAZE_SPEED)).toBeGreaterThan(0);
    expect(collisionDamage(20)).toBeCloseTo(2 * collisionDamage(10));
  });

  it('leaves ramming a bad idea: the worst collision in the game is a fraction of a hull', () => {
    // Two Mediums at flank, bow to bow — about 28 m/s of closing, and the most this system can do.
    const worst = collisionDamage(2 * getHull('medium').stats.maxSpeed);
    expect(worst).toBeLessThan(getHull('medium').stats.maxHp / 3);
  });
});
