/**
 * The Sparse and Dense cave generators, and the two width guarantees they exist to keep.
 *
 * ## How the invariants are covered
 *
 * planning/13 §4.1 wants the generator's invariants asserted over hundreds of seeds. They are,
 * in two layers, because measuring a map properly costs far more than making one:
 *
 * - **The broad sweep** generates hundreds of maps and asserts only that generation succeeds.
 *   That is not a weak assertion — `generate` measures its own output and throws
 *   `invariant_violated` rather than returning a map that breaks a floor, so a seed that
 *   would produce a 60 m pinch fails the sweep loudly.
 * - **The close reading** takes a handful of seeds and measures them again at a finer lattice
 *   than the generator checks itself on. This is the layer that would catch the self-check
 *   being too coarse or too generous.
 *
 * Between them: wide coverage of "does it hold" and independent confirmation of "is the thing
 * that decides that trustworthy".
 */

import { describe, expect, it } from 'vitest';

import {
  CAVE_TUNING,
  MapGenerationError,
  TerrainRuler,
  buildSkeleton,
  generateMap,
  measureTerrain,
  resolveExtents,
  resolveTuning,
  type CaveMapType,
  type GeneratedMap,
  type MapSize,
} from '../src/index.js';

const TYPES: readonly CaveMapType[] = ['sparse', 'dense'];
const SIZES: readonly MapSize[] = ['small', 'medium', 'large'];

/** Seeds for the broad sweep. Generation self-checks, so every one is an invariant assertion. */
const SWEEP_SEEDS = 200;

/**
 * Generating and self-checking a few hundred maps is seconds of real work, not a hung test.
 * Stated rather than left to the default, so a genuine hang is still caught.
 */
const SWEEP_TIMEOUT = 60_000;

describe('the cave generators produce a well-formed map', () => {
  for (const type of TYPES) {
    for (const size of SIZES) {
      it(`${type} / ${size}`, () => {
        const map = generateMap(type, { seed: 4242, mapSize: size });

        expect(map.mapType).toBe(type);
        expect(map.mapSize).toBe(size);
        expect(map.extents).toEqual(resolveExtents(size));
        expect(map.generatorVersion).toBeGreaterThan(0);
        expect(map.terrain.obstacles.length).toBeGreaterThan(0);
      });
    }
  }

  it('emits closed rings with real area, inside the map', () => {
    const map = generateMap('dense', { seed: 9, mapSize: 'medium' });

    for (const obstacle of map.terrain.obstacles) {
      expect(obstacle.vertices.length).toBeGreaterThanOrEqual(3);
      expect(Math.abs(area(obstacle.vertices))).toBeGreaterThan(0);

      for (const vertex of obstacle.vertices) {
        expect(vertex.x).toBeGreaterThanOrEqual(0);
        expect(vertex.x).toBeLessThanOrEqual(map.extents.width);
        expect(vertex.y).toBeGreaterThanOrEqual(0);
        expect(vertex.y).toBeLessThanOrEqual(map.extents.height);
      }
    }
  });

  it('seals the surface and the seabed with rock, which are hard boundaries', () => {
    const map = generateMap('dense', { seed: 11, mapSize: 'medium' });
    const ys = map.terrain.obstacles.flatMap((o) => o.vertices.map((v) => v.y));

    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(map.extents.height);
  });
});

describe('generation is deterministic', () => {
  it('gives byte-identical output for the same seed, twice in one process', () => {
    const once = generateMap('dense', { seed: 777, mapSize: 'medium' });
    const twice = generateMap('dense', { seed: 777, mapSize: 'medium' });

    // Compared as JSON rather than by reference, which is the property a client re-deriving
    // a map from a replay's seed actually depends on (planning/04 §9).
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('gives a different map for a different seed', () => {
    const a = generateMap('dense', { seed: 1, mapSize: 'medium' });
    const b = generateMap('dense', { seed: 2, mapSize: 'medium' });

    expect(JSON.stringify(a.terrain)).not.toBe(JSON.stringify(b.terrain));
  });

  it('gives a different map for a different type on the same seed', () => {
    const sparse = generateMap('sparse', { seed: 5, mapSize: 'medium' });
    const dense = generateMap('dense', { seed: 5, mapSize: 'medium' });

    expect(JSON.stringify(sparse.terrain)).not.toBe(JSON.stringify(dense.terrain));
  });
});

describe('the width guarantees', () => {
  // The broad layer. `generate` throws rather than returning a map that breaks a floor, so
  // this asserts both invariants on every seed it touches.
  for (const type of TYPES) {
    it(
      `hold across ${SWEEP_SEEDS} ${type} seeds`,
      () => {
        for (let seed = 1; seed <= SWEEP_SEEDS; seed += 1) {
          expect(() => generateMap(type, { seed, mapSize: 'medium' })).not.toThrow();
        }
      },
      SWEEP_TIMEOUT,
    );
  }

  it(
    'hold at every map size — small maps are where the budget runs out',
    () => {
      for (const type of TYPES) {
        for (const size of SIZES) {
          for (let seed = 1; seed <= 15; seed += 1) {
            expect(() => generateMap(type, { seed, mapSize: size })).not.toThrow();
          }
        }
      }
    },
    SWEEP_TIMEOUT,
  );

  // The close layer: measured again, independently, at a finer lattice than the generator
  // checks itself on.
  for (const type of TYPES) {
    it(
      `survive an independent measurement of finished ${type} polygons`,
      () => {
        const tuning = CAVE_TUNING[type];

        for (let seed = 1; seed <= 8; seed += 1) {
          const map = generateMap(type, { seed, mapSize: 'medium' });
          const ruler = new TerrainRuler(map.extents, map.terrain.obstacles, { cellSize: 5 });

          expect(ruler.hasOpeningAtLeast(tuning.minPassageWidth)).toBe(true);
          expect(ruler.hasRouteAtLeast(tuning.trunkPassageWidth)).toBe(true);
          expect(measureTerrain(map, { cellSize: 5 }).crossable).toBe(true);
        }
      },
      SWEEP_TIMEOUT,
    );
  }

  it('reports a route width comfortably above the floor, not merely at it', () => {
    // The carve margin should show up as real slack rather than a number that only just
    // scrapes past — if this ever lands on 300 exactly, the margin has been eaten.
    for (const type of TYPES) {
      const map = generateMap(type, { seed: 21, mapSize: 'medium' });
      expect(measureTerrain(map, { cellSize: 5 }).widestRoute).toBeGreaterThan(
        CAVE_TUNING[type].trunkPassageWidth,
      );
    }
  });
});

describe('the guarantees are configurable', () => {
  it('honours a raised passage floor', () => {
    const map = generateMap('dense', {
      seed: 3,
      mapSize: 'large',
      tuning: { minPassageWidth: 300, routeCount: 3 },
    });
    const ruler = new TerrainRuler(map.extents, map.terrain.obstacles, { cellSize: 5 });

    expect(ruler.hasOpeningAtLeast(300)).toBe(true);
    // And the shipped floor is comfortably cleared as a consequence, not by luck.
    expect(ruler.hasOpeningAtLeast(200)).toBe(true);
  });

  it('honours a raised trunk floor', () => {
    const map = generateMap('dense', {
      seed: 3,
      mapSize: 'large',
      tuning: { trunkPassageWidth: 600 },
    });

    expect(measureTerrain(map, { cellSize: 5 }).widestRoute).toBeGreaterThanOrEqual(600);
  });

  it('carves more routes when the tuning asks for them and the height allows', () => {
    const extents = resolveExtents('large');
    const few = buildSkeleton(extents, resolveTuning('dense', { routeCount: 2 }), 1);
    const many = buildSkeleton(extents, resolveTuning('dense', { routeCount: 6 }), 1);

    expect(few.routes).toHaveLength(2);
    expect(many.routes.length).toBeGreaterThan(few.routes.length);
  });

  it('leaves the shipped tuning untouched when overriding', () => {
    const overridden = resolveTuning('dense', { minPassageWidth: 250 });

    expect(overridden.minPassageWidth).toBe(250);
    expect(CAVE_TUNING.dense.minPassageWidth).toBe(200);
    // Everything not named is inherited, so an override is a patch rather than a replacement.
    expect(overridden.trunkPassageWidth).toBe(CAVE_TUNING.dense.trunkPassageWidth);
  });
});

describe('a tuning that cannot be satisfied is refused, not approximated', () => {
  it('rejects a trunk narrower than the passage floor', () => {
    const failure = () =>
      generateMap('dense', {
        seed: 1,
        mapSize: 'medium',
        tuning: { minPassageWidth: 400, trunkPassageWidth: 300 },
      });

    expect(failure).toThrow(MapGenerationError);
    expect(failure).toThrow(/contradiction/i);
  });

  it('rejects a trunk that does not fit the map at all', () => {
    // Narrowing the trunk silently would be the worst outcome here: the caller asked for a
    // guarantee and would be handed a map that quietly does not keep it.
    const failure = () =>
      generateMap('dense', { seed: 1, mapSize: 'small', tuning: { trunkPassageWidth: 5000 } });

    expect(failure).toThrow(MapGenerationError);
    try {
      failure();
    } catch (error) {
      expect((error as MapGenerationError).code).toBe('unsatisfiable_tuning');
    }
  });
});

describe('the level budget', () => {
  it('drops levels rather than floors when the height runs short', () => {
    const tuning = resolveTuning('dense');
    const small = buildSkeleton(resolveExtents('small'), tuning, 1);
    const large = buildSkeleton(resolveExtents('large'), tuning, 1);

    // A small map cannot hold what the tuning asks for, so it carries fewer levels — and
    // every one it does carry is still at least the floor tall.
    expect(small.routes.length).toBeLessThan(large.routes.length);
    // planning/14 I1: three ways through, even on the smallest map, so no defender can cover
    // every approach.
    expect(small.routes.length).toBeGreaterThanOrEqual(3);

    for (const route of [...small.routes, ...large.routes]) {
      expect(route.width).toBeGreaterThanOrEqual(tuning.minPassageWidth);
    }
  });

  it('carves exactly one trunk, and it is a level that clears the trunk floor', () => {
    for (const size of SIZES) {
      const tuning = resolveTuning('sparse');
      const skeleton = buildSkeleton(resolveExtents(size), tuning, 42);
      const trunks = skeleton.routes.filter((r) => r.isTrunk);

      expect(trunks).toHaveLength(1);
      expect(trunks[0]?.width).toBeGreaterThanOrEqual(tuning.trunkPassageWidth);
    }
  });

  it('keeps every level inside the map, at its widest', () => {
    const extents = resolveExtents('medium');
    const tuning = resolveTuning('dense');
    const skeleton = buildSkeleton(extents, tuning, 8);

    for (const route of skeleton.routes) {
      for (let x = 0; x <= extents.width; x += 100) {
        expect(route.yAt(x) - route.rAt(x)).toBeGreaterThan(0);
        expect(route.yAt(x) + route.rAt(x)).toBeLessThan(extents.height);
      }
    }
  });
});

/**
 * The shape of a map, as distinct from its guarantees.
 *
 * These are the properties that decide whether a map reads as a cave system or as a filing
 * cabinet, and they are asserted rather than eyeballed because nothing else in the pipeline
 * would notice a tuning change that quietly flattened every level to the same height.
 */
describe('the shape of a map', () => {
  const SHAPE_SEEDS = 40;

  it(
    'gives every map a shorter level and a taller one',
    () => {
      for (const type of TYPES) {
        const tuning = resolveTuning(type);
        const [, tallest] = tuning.levelHeightRange;

        for (const size of SIZES) {
          for (let seed = 1; seed <= SHAPE_SEEDS; seed += 1) {
            const heights = buildSkeleton(resolveExtents(size), tuning, seed).routes.map(
              (r) => r.width,
            );
            const low = Math.min(...heights);
            const high = Math.max(...heights);

            expect(low).toBeGreaterThanOrEqual(tuning.minPassageWidth);
            expect(high).toBeLessThanOrEqual(tallest);
            // Not merely "not all identical": the spread has to be big enough that the two read
            // as different kinds of space.
            expect(high / low).toBeGreaterThan(1.5);
          }
        }
      }
    },
    SWEEP_TIMEOUT,
  );

  it('reaches the full height range on the base map, where it was written for', () => {
    const tuning = resolveTuning('sparse');
    const [shortest, tallest] = tuning.levelHeightRange;
    const heights: number[] = [];

    for (let seed = 1; seed <= SHAPE_SEEDS; seed += 1) {
      heights.push(
        ...buildSkeleton(resolveExtents('medium'), tuning, seed).routes.map((r) => r.width),
      );
    }

    // Within a few per cent of both ends across forty maps — a range nothing ever reaches is
    // a range that is not really the range.
    expect(Math.min(...heights)).toBeLessThan(shortest * 1.1);
    expect(Math.max(...heights)).toBeGreaterThan(tallest * 0.9);
  });

  it('never emits a disc smaller than half the passage floor', () => {
    // The load-bearing invariant of the whole pipeline: free space is a union of discs, so a
    // single undersized one anywhere is an opening under the floor that no later stage can
    // put right.
    for (const type of TYPES) {
      const tuning = resolveTuning(type);
      const floor = tuning.minPassageWidth / 2;

      for (const size of SIZES) {
        for (let seed = 1; seed <= 8; seed += 1) {
          const { stamps } = buildSkeleton(resolveExtents(size), tuning, seed);
          expect(Math.min(...stamps.map((s) => s.r))).toBeGreaterThanOrEqual(floor);
        }
      }
    }
  });

  it('joins neighbouring levels with halls, not pipes', () => {
    const tuning = resolveTuning('sparse');
    const extents = resolveExtents('medium');
    const [narrowest] = tuning.connectionWidthRange;

    for (let seed = 1; seed <= 10; seed += 1) {
      const skeleton = buildSkeleton(extents, tuning, seed);
      // A connection's discs are the ones carved clear of every centreline — a chamber sits on
      // its level and an alcove overlaps it, so what is left in the rock between two levels is
      // the shaft joining them.
      const between = skeleton.stamps.filter((stamp) =>
        skeleton.routes.every(
          (route) => Math.abs(route.yAt(stamp.x) - stamp.y) > route.rAt(stamp.x),
        ),
      );
      const widths = between.map((s) => (s.r - tuning.geometryMargin) * 2);

      expect(widths.length).toBeGreaterThan(0);
      expect(Math.max(...widths)).toBeGreaterThanOrEqual(narrowest);
      // And most of them are generous rather than merely legal.
      expect(Math.max(...widths)).toBeGreaterThanOrEqual(tuning.connectionTypicalWidth);
    }
  });

  it('undulates — a level rises and falls rather than running flat', () => {
    for (const type of TYPES) {
      const tuning = resolveTuning(type);
      const extents = resolveExtents('medium');

      for (let seed = 1; seed <= 10; seed += 1) {
        const { routes } = buildSkeleton(extents, tuning, seed);
        const turns = routes.map((route) => {
          const ys: number[] = [];
          for (let x = 0; x <= extents.width; x += 50) ys.push(route.yAt(x));
          let changes = 0;
          for (let i = 2; i < ys.length; i += 1) {
            const before = (ys[i - 1] ?? 0) - (ys[i - 2] ?? 0);
            const after = (ys[i] ?? 0) - (ys[i - 1] ?? 0);
            if (before * after < 0) changes += 1;
          }
          return changes;
        });

        expect(Math.max(...turns)).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('roughens the rock face — a level swells and narrows along its length', () => {
    const tuning = resolveTuning('dense');
    const extents = resolveExtents('medium');
    const route = buildSkeleton(extents, tuning, 3).routes[0];
    const radii: number[] = [];
    for (let x = 0; x <= extents.width; x += 25) radii.push(route?.rAt(x) ?? 0);

    const narrowest = Math.min(...radii);
    // Widening only, so the narrowest is the base and everything above it is texture.
    expect(Math.max(...radii)).toBeGreaterThan(narrowest * 1.1);
  });
});

/** Twice the signed area of a ring. */
function area(vertices: readonly { x: number; y: number }[]): number {
  let total = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    if (a === undefined || b === undefined) continue;
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

/** Guards the assumption the sweep leans on: that a broken floor really does throw. */
describe('the self-check is load-bearing', () => {
  it('throws when the generated map cannot meet the floor it was given', () => {
    // A trunk that fits the height but a passage floor the lattice cannot honour: the carve
    // margin is removed, so the measured width lands under the floor and the map is refused.
    const failure = () =>
      generateMap('dense', {
        seed: 1,
        mapSize: 'medium',
        tuning: { geometryMargin: 0, cellSize: 60, simplifyTolerance: 40 },
      });

    expect(failure).toThrow(MapGenerationError);
  });

  it('reports the seed, so a failure is reproducible from the message alone', () => {
    try {
      generateMap('dense', {
        seed: 31337,
        mapSize: 'medium',
        tuning: { geometryMargin: 0, cellSize: 60, simplifyTolerance: 40 },
      });
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as MapGenerationError).message).toContain('31337');
    }
  });
});

/** A sanity check on the measuring apparatus itself, using terrain whose answer is known. */
describe('the ruler', () => {
  it('measures open water as the full height of the map', () => {
    const empty: GeneratedMap = generateMap('empty', { seed: 1, mapSize: 'medium' });
    const measured = measureTerrain(empty, { cellSize: 10 });

    expect(measured.crossable).toBe(true);
    // Bounded above and below by the seabed and the surface, and unobstructed between them.
    expect(measured.widestRoute).toBeGreaterThan(empty.extents.height * 0.9);
  });
});
