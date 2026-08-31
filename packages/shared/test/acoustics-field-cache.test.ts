/**
 * The field cache is unobservable (planning/16 §3.1).
 *
 * A cached field is a real optimization only if nothing downstream can tell it happened. That is a
 * stronger claim than "the ranges are close", and it is the one these tests make: the *same* solve,
 * run against an arena that caches and an arena that does not, must produce identical fields and
 * identical pictures — cell for cell, bit for bit, in the same order.
 *
 * The danger the exactness guards against is specific (§3.1.2). A field's ranges are
 * `seed + graphDistance`, and accumulating the seed through the sweep is not bit-identical to
 * adding it afterwards. `factorAt` floors range into a 1 m table where that difference is invisible
 * *until* a range lands within 10⁻¹² of an integer. If a hit and a miss disagreed there, which one
 * a solve got would depend on where the boat had been on previous ticks — the cache's hit pattern,
 * a fact about history, leaking into the heatmap. So the seed is added at read time on both paths,
 * and these tests are how anyone would find out if that stopped being true.
 */

import {
  ACOUSTICS,
  AcousticSolver,
  FieldArena,
  WaterLattice,
  type AcousticEntity,
  type GeneratedMap,
  type MapExtents,
  type Obstacle,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

const EXTENTS: MapExtents = { width: 2000, height: 1000 };
const CELL = 20;

function block(x0: number, y0: number, x1: number, y1: number): Obstacle {
  return {
    vertices: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
  };
}

/** A wall with a door in it — the fixture that makes geodesic range differ from straight range. */
const OBSTACLES: Obstacle[] = [block(960, 0, 1040, 420), block(960, 580, 1040, 1000)];

function world(): GeneratedMap {
  return {
    extents: EXTENTS,
    seed: 7,
    mapType: 'empty',
    mapSize: 'small',
    terrain: { obstacles: OBSTACLES },
    spawns: [],
    objectives: [],
  } as unknown as GeneratedMap;
}

function entity(id: number, x: number, y: number, sourceLevel: number): AcousticEntity {
  return {
    id,
    team: id % 2 === 0 ? 'team1' : 'team2',
    pos: { x, y },
    sourceLevel,
    deafeningLevel: sourceLevel,
    absorption: ACOUSTICS.hullAbsorption,
    outline: null,
    hydrophone: { gain: 20, selfNoise: 10 },
  };
}

/**
 * Positions that are deliberately awkward for the cache: several inside one lattice cell (so the
 * seed varies while the start cell does not), one exactly on a cell centre (seed zero), and one in
 * a near corner (the largest seed a cell can produce).
 */
const OFFSETS = [
  [0, 0],
  [6, 0],
  [-7, 4],
  [9, -9],
  [-9.5, -9.5],
] as const;

describe('the field cache', () => {
  it('returns the same cells and the same ranges as a fresh sweep, in the same order', () => {
    const grid = new WaterLattice(EXTENTS, OBSTACLES, { cellSize: CELL });
    const cached = new FieldArena(grid);
    const fresh = new FieldArena(grid, { cache: false });

    // Sweep the same cell five times over, from five sub-cell positions. The first is a miss on
    // both arenas; the rest are hits on one and full sweeps on the other, which is the comparison.
    for (let pass = 0; pass < 3; pass += 1) {
      for (const [dx, dy] of OFFSETS) {
        const x = 500 + dx;
        const y = 500 + dy;
        cached.reset();
        fresh.reset();
        const a = cached.solve(x, y, { maxRange: 1200, maxCells: 1e9 });
        const b = fresh.solve(x, y, { maxRange: 1200, maxCells: 1e9 });

        expect(a.count).toBe(b.count);
        for (let i = 0; i < b.count; i += 1) {
          expect(cached.cellAt(a, i)).toBe(fresh.cellAt(b, i));
          // Exact equality, not `toBeCloseTo`. A metre of drift is a different game (§3.2), and a
          // difference in the last bits is the one this cache could actually introduce.
          expect(cached.rangeAt(a, i)).toBe(fresh.rangeAt(b, i));
        }
      }
    }

    expect(cached.cacheHits).toBeGreaterThan(0);
    expect(fresh.cacheHits).toBe(0);
  });

  it('trims to a shorter range rather than handing back the radius it swept', () => {
    const grid = new WaterLattice(EXTENTS, OBSTACLES, { cellSize: CELL });
    const cached = new FieldArena(grid);
    const fresh = new FieldArena(grid, { cache: false });

    // Warm the cache at the longer radius, then ask for a shorter one from the same cell.
    cached.reset();
    cached.solve(500, 500, { maxRange: 1200, maxCells: 1e9 });

    cached.reset();
    fresh.reset();
    const a = cached.solve(500, 500, { maxRange: 400, maxCells: 1e9 });
    const b = fresh.solve(500, 500, { maxRange: 400, maxCells: 1e9 });

    expect(a.count).toBe(b.count);
    expect(a.count).toBeGreaterThan(0);
    for (let i = 0; i < b.count; i += 1) {
      expect(cached.cellAt(a, i)).toBe(fresh.cellAt(b, i));
      expect(cached.rangeAt(a, i)).toBe(fresh.rangeAt(b, i));
      expect(cached.rangeAt(a, i)).toBeLessThanOrEqual(400);
    }
  });

  it('re-sweeps when asked for more range than it holds', () => {
    const grid = new WaterLattice(EXTENTS, OBSTACLES, { cellSize: CELL });
    const cached = new FieldArena(grid);
    const fresh = new FieldArena(grid, { cache: false });

    cached.reset();
    cached.solve(500, 500, { maxRange: 400, maxCells: 1e9 });
    const afterWarm = cached.cacheMisses;

    cached.reset();
    fresh.reset();
    const a = cached.solve(500, 500, { maxRange: 1600, maxCells: 1e9 });
    const b = fresh.solve(500, 500, { maxRange: 1600, maxCells: 1e9 });

    expect(cached.cacheMisses).toBe(afterWarm + 1);
    expect(a.count).toBe(b.count);
    for (let i = 0; i < b.count; i += 1) {
      expect(cached.rangeAt(a, i)).toBe(fresh.rangeAt(b, i));
    }
  });

  it('gives two entities in one cell the same field, from one sweep', () => {
    const grid = new WaterLattice(EXTENTS, OBSTACLES, { cellSize: CELL });
    const arena = new FieldArena(grid);
    arena.reset();

    const a = arena.solve(500, 500, { maxRange: 800, maxCells: 1e9 });
    const before = arena.cacheMisses;
    const b = arena.solve(502, 501, { maxRange: 800, maxCells: 1e9 });

    // Same cell, so the second is served from the first — and the two handles are distinct
    // regions of the arena, not the same one handed out twice.
    expect(arena.cacheMisses).toBe(before);
    expect(b.offset).toBe(a.offset + a.count);
  });

  it('produces an identical picture through a whole solve', () => {
    const map = world();
    const shipped = new AcousticSolver(map, { cellSize: CELL });
    const uncached = new AcousticSolver(map, { cellSize: CELL, fields: { cache: false } });

    // Nine ticks of a fleet drifting a metre and a half a solve — a Light at flank, which is the
    // rate §3.1.3 puts at a 93% hit rate. Some solves cross a cell boundary and some do not, so
    // this walks both the hit and the miss path with the same geometry.
    for (let tick = 0; tick < 9; tick += 1) {
      const drift = tick * 1.5;
      const fleet = [
        entity(1, 400 + drift, 500, 60),
        entity(2, 1500 - drift, 500, 45),
        entity(3, 700, 300 + drift, 90),
        entity(4, 1200 + drift, 700 - drift, 45),
      ];

      const a = shipped.solve(fleet);
      const b = uncached.solve(fleet);

      expect(a.stats).toEqual(b.stats);
      expect(a.vision.length).toBe(b.vision.length);
      for (let v = 0; v < b.vision.length; v += 1) {
        const seen = a.vision[v];
        const want = b.vision[v];
        expect(seen?.team).toBe(want?.team);
        expect(seen?.dropped).toBe(want?.dropped);
        expect([...(seen?.cells ?? [])]).toEqual([...(want?.cells ?? [])]);
        expect([...(seen?.excess ?? [])]).toEqual([...(want?.excess ?? [])]);
        expect([...(seen?.owners ?? [])]).toEqual([...(want?.owners ?? [])]);
      }
    }
  });

  /**
   * The reflection walk's derived stopping range (planning/16 §3.8).
   *
   * `look` now stops once no cell can still clear a gate: the loudest cell in the whole heatmap,
   * against the weakest gate in the match, gives a range past which `incident × back` cannot reach
   * `thresholdPower × absorption` for any cell of any kind. Because both halves are measurements of
   * the tick rather than constants, this cannot drop a square — which is exactly the claim §3.4
   * could not make, and exactly the claim that needs checking rather than asserting.
   *
   * The scene is deliberately awkward for it: one very loud boat and one nearly silent one, so the
   * global `maxIncident` is set by an entity that most listeners are nowhere near, and the bound is
   * as loose for them as it can be. Any off-by-one in the table inversion or in the bucket-order
   * slack shows up here as a missing square.
   */
  it('stops the reflection walk early without changing a single square', () => {
    const map = world();
    const bounded = new AcousticSolver(map, { cellSize: CELL });
    const whole = new AcousticSolver(map, { cellSize: CELL, reflectionBound: false });

    for (let tick = 0; tick < 6; tick += 1) {
      const drift = tick * 1.5;
      const fleet = [
        entity(1, 400 + drift, 500, 116),
        entity(2, 1500 - drift, 500, 30),
        entity(3, 700, 300 + drift, 60),
        entity(4, 1200 + drift, 700 - drift, 45),
      ];

      const a = bounded.solve(fleet);
      const b = whole.solve(fleet);

      expect(a.vision.length).toBe(b.vision.length);
      for (let v = 0; v < b.vision.length; v += 1) {
        const seen = a.vision[v]!;
        const want = b.vision[v]!;
        // Every square, in the same order, at the same brightness, attached to the same thing.
        expect([...seen.cells]).toEqual([...want.cells]);
        expect([...seen.excess]).toEqual([...want.excess]);
        expect([...seen.owners]).toEqual([...want.owners]);
        expect(seen.dropped).toBe(want.dropped);
      }

      // And it is really stopping short, rather than passing by never firing.
      expect(a.stats.lookCells).toBeLessThan(b.stats.lookCells);
    }
  });

  it('evicts rather than growing without bound, and stays exact once it has', () => {
    const grid = new WaterLattice(EXTENTS, OBSTACLES, { cellSize: CELL });
    // A budget far too small to hold two fields, so every solve below evicts the last one.
    const tiny = new FieldArena(grid, { cacheCells: 500 });
    const fresh = new FieldArena(grid, { cache: false });

    for (let i = 0; i < 12; i += 1) {
      const x = 300 + i * 40;
      tiny.reset();
      fresh.reset();
      const a = tiny.solve(x, 500, { maxRange: 600, maxCells: 1e9 });
      const b = fresh.solve(x, 500, { maxRange: 600, maxCells: 1e9 });

      expect(a.count).toBe(b.count);
      for (let k = 0; k < b.count; k += 1) {
        expect(tiny.rangeAt(a, k)).toBe(fresh.rangeAt(b, k));
      }
    }

    expect(tiny.cachedFieldCells).toBeLessThanOrEqual(500);
  });

  it('does not cache a field the cell guardrail cut short', () => {
    const grid = new WaterLattice(EXTENTS, OBSTACLES, { cellSize: CELL });
    const arena = new FieldArena(grid);

    arena.reset();
    arena.solve(500, 500, { maxRange: 1200, maxCells: 200 });
    expect(arena.clippedFields).toBe(1);

    // A clipped field is a prefix in bucket order, so it cannot answer a shorter request without
    // being short of cells a tighter sweep would have had room for. It is re-swept instead.
    const before = arena.cacheMisses;
    arena.reset();
    arena.solve(500, 500, { maxRange: 1200, maxCells: 200 });
    expect(arena.cacheMisses).toBe(before + 1);
  });
});
