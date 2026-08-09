/**
 * Propagation: where the water is, how far sound has to swim to get somewhere, and which
 * squares of surface can send it back.
 *
 * The claim under test is the one the whole model rests on — **sound travels through water and
 * through nothing else**. Everything else in the acoustic system is arithmetic on a number
 * this layer produces, so if a path leaks through a wall the tuning table cannot save it.
 *
 * The terrain here is hand-built rather than generated: a wall with a door in it is a fixture
 * whose right answer can be worked out on paper, which a procedural cave is not.
 */

import {
  ACOUSTICS,
  FieldArena,
  getHull,
  terrainReflectors,
  visionCellCentre,
  visionGridFor,
  VISION_CELL_SIZE,
  WaterLattice,
  type MapExtents,
  type Obstacle,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

const EXTENTS: MapExtents = { width: 2000, height: 1000 };
const CELL = 20;

/** An axis-aligned block of rock. */
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

/** A wall across the middle of the map, with a gap left in it at the given band of y. */
function wallWithDoor(doorLow: number, doorHigh: number): Obstacle[] {
  return [block(960, 0, 1040, doorLow), block(960, doorHigh, 1040, 1000)];
}

function lattice(obstacles: readonly Obstacle[]): WaterLattice {
  return new WaterLattice(EXTENTS, obstacles, { cellSize: CELL });
}

/** The geodesic range from a point to a point, or `Infinity` if sound cannot get there. */
function rangeBetween(
  grid: WaterLattice,
  from: { x: number; y: number },
  to: { x: number; y: number },
  maxRange = 6000,
): number {
  const arena = new FieldArena(grid);
  const field = arena.solve(from.x, from.y, { maxRange, maxCells: 1e9 });
  const target = grid.waterIndexAt(to.x, to.y);
  for (let i = 0; i < field.count; i += 1) {
    if (arena.cellAt(field, i) === target) return arena.rangeAt(field, i);
  }
  return Infinity;
}

describe('the water lattice', () => {
  it('is all water when there is no terrain', () => {
    const grid = lattice([]);
    expect(grid.water.every((v) => v === 1)).toBe(true);
    expect(grid.cellCount).toBe(grid.cols * grid.rows);
  });

  it('marks the inside of an obstacle as rock and the outside as water', () => {
    const grid = lattice([block(400, 400, 600, 600)]);
    expect(grid.water[grid.indexAt(500, 500)]).toBe(0);
    expect(grid.water[grid.indexAt(300, 500)]).toBe(1);
    expect(grid.water[grid.indexAt(500, 300)]).toBe(1);
  });

  it('hears a point inside rock from the water beside it', () => {
    // A boat scraping a wall, a wreck in the seabed, and every square metre of rock face are
    // all in rock and all still have to emit and reflect.
    const grid = lattice([block(400, 400, 600, 600)]);
    const inside = grid.indexAt(500, 500);
    const heardAt = grid.waterIndexAt(500, 500);
    expect(heardAt).not.toBe(inside);
    expect(grid.water[heardAt]).toBe(1);
  });
});

describe('path length', () => {
  it('is the straight line in open water, to within the lattice’s own error', () => {
    const grid = lattice([]);
    const straight = 800;
    const measured = rangeBetween(grid, { x: 400, y: 500 }, { x: 400 + straight, y: 500 });
    expect(measured).toBeGreaterThan(straight - CELL);
    expect(measured).toBeLessThan(straight + CELL);
  });

  it('costs no more than 6% extra on a diagonal — the octagon error, and it is bounded', () => {
    // Eight-connected stepping cannot draw a true diagonal, so it overstates one by up to
    // 5.7%. At the model's spreading that is under half a decibel, which is why it is left
    // alone rather than corrected; what matters is that it stays bounded.
    const grid = lattice([]);
    const straight = Math.hypot(600, 600);
    const measured = rangeBetween(grid, { x: 200, y: 200 }, { x: 800, y: 800 });
    expect(measured).toBeGreaterThan(straight - CELL);
    expect(measured / straight).toBeLessThan(1.06);
  });

  it('goes around a wall rather than through it', () => {
    // The door is at the top; two boats level with the bottom must route all the way up and
    // back down, which is far longer than the 800 m of straight line between them.
    const grid = lattice(wallWithDoor(800, 900));
    const around = rangeBetween(grid, { x: 600, y: 200 }, { x: 1400, y: 200 });
    expect(around).toBeGreaterThan(1500);
    expect(around).toBeLessThan(2000);
    // Twice the straight line, which is the whole of "get a wall between us".
    expect(around).toBeGreaterThan(2 * 800 - CELL);
  });

  it('takes the door when the door is on the way', () => {
    const grid = lattice(wallWithDoor(400, 600));
    const through = rangeBetween(grid, { x: 600, y: 500 }, { x: 1400, y: 500 });
    expect(through).toBeLessThan(900);
  });

  it('never reaches a sealed chamber', () => {
    const grid = lattice([
      block(400, 400, 700, 420),
      block(400, 680, 700, 700),
      block(400, 400, 420, 700),
      block(680, 400, 700, 700),
    ]);
    expect(rangeBetween(grid, { x: 200, y: 550 }, { x: 550, y: 550 })).toBe(Infinity);
    // And the other way round, because a one-way wall would be worse than a leaky one.
    expect(rangeBetween(grid, { x: 550, y: 550 }, { x: 200, y: 550 })).toBe(Infinity);
  });

  it('does not squeeze through a diagonal join', () => {
    // Two blocks touching corner to corner are sealed. Allowing the diagonal step would let
    // sound through a wall that has no opening in it at all.
    const grid = lattice([block(0, 0, 500, 500), block(500, 500, 2000, 1000)]);
    expect(rangeBetween(grid, { x: 200, y: 700 }, { x: 700, y: 200 }, 4000)).toBe(Infinity);
  });

  it('stops at the range it was given', () => {
    const grid = lattice([]);
    const arena = new FieldArena(grid);
    const field = arena.solve(1000, 500, { maxRange: 300, maxCells: 1e9 });
    expect(field.count).toBeGreaterThan(100);
    for (let i = 0; i < field.count; i += 1) {
      expect(arena.rangeAt(field, i)).toBeLessThanOrEqual(300);
    }
  });

  it('stops at the cell count it was given, and says so', () => {
    const grid = lattice([]);
    const arena = new FieldArena(grid);
    const field = arena.solve(1000, 500, { maxRange: 6000, maxCells: 500 });
    expect(field.count).toBe(500);
    expect(arena.clippedFields).toBe(1);
  });

  it('starts at the cell the source is standing in', () => {
    const grid = lattice([]);
    const arena = new FieldArena(grid);
    const field = arena.solve(1234, 567, { maxRange: 400, maxCells: 1e9 });
    expect(arena.cellAt(field, 0)).toBe(grid.indexAt(1234, 567));
    expect(arena.rangeAt(field, 0)).toBeLessThan(CELL);
  });

  it('gives the same answer twice, which replays depend on', () => {
    const grid = lattice(wallWithDoor(300, 500));
    const a = new FieldArena(grid);
    const b = new FieldArena(grid);
    const fa = a.solve(500, 500, { maxRange: 2000, maxCells: 1e9 });
    const fb = b.solve(500, 500, { maxRange: 2000, maxCells: 1e9 });

    expect(fa.count).toBe(fb.count);
    for (let i = 0; i < fa.count; i += 1) {
      expect(a.cellAt(fa, i)).toBe(b.cellAt(fb, i));
      expect(a.rangeAt(fa, i)).toBe(b.rangeAt(fb, i));
    }
  });

  it('reuses its buffers without leaking one field into the next', () => {
    const grid = lattice([]);
    const arena = new FieldArena(grid);
    const first = arena.solve(500, 500, { maxRange: 400, maxCells: 1e9 });
    const second = arena.solve(1500, 500, { maxRange: 400, maxCells: 1e9 });

    expect(second.offset).toBe(first.count);
    // The second sweep is centred a thousand metres away; nothing it holds may be a cell the
    // first one owned.
    expect(arena.cellAt(second, 0)).toBe(grid.indexAt(1500, 500));
    expect(arena.cellAt(first, 0)).toBe(grid.indexAt(500, 500));
  });
});

describe('the reflector skin', () => {
  const grid = visionGridFor(EXTENTS);

  it('traces the surface of an obstacle, one square of skin at a time', () => {
    const cells = terrainReflectors(grid, EXTENTS, [block(400, 400, 600, 600)]);
    // The block's perimeter is 800 m, so it is 800 / VISION_CELL_SIZE squares of skin — give or
    // take the corners, which each land in one square shared by two faces. Plus the seabed and
    // the surface across the map, which the y filter drops.
    const expected = 800 / VISION_CELL_SIZE;
    const perimeter = [...cells].filter((c) => {
      const p = visionCellCentre(grid, c);
      return p.y > VISION_CELL_SIZE && p.y < EXTENTS.height - VISION_CELL_SIZE;
    });
    expect(perimeter.length).toBeGreaterThan(expected * 0.875);
    expect(perimeter.length).toBeLessThan(expected * 1.04);

    // Every one of them on a face of the block, within the square that face falls in.
    const slack = VISION_CELL_SIZE;
    for (const c of perimeter) {
      const p = visionCellCentre(grid, c);
      const onEdge =
        (Math.abs(p.x - 400) < slack || Math.abs(p.x - 600) < slack) &&
        p.y >= 400 - slack &&
        p.y <= 600 + slack;
      const onFace =
        (Math.abs(p.y - 400) < slack || Math.abs(p.y - 600) < slack) &&
        p.x >= 400 - slack &&
        p.x <= 600 + slack;
      expect(onEdge || onFace).toBe(true);
    }
  });

  it('includes the seabed and the surface, which no obstacle draws', () => {
    const cells = terrainReflectors(grid, EXTENTS, []);
    expect(cells.length).toBe(2 * grid.cols);
    const heights = new Set([...cells].map((c) => visionCellCentre(grid, c).y));
    expect([...heights].sort((a, b) => a - b)).toEqual([
      VISION_CELL_SIZE / 2,
      EXTENTS.height - VISION_CELL_SIZE / 2,
    ]);
  });

  it('reports each square once, however many rings share an edge', () => {
    const cells = terrainReflectors(grid, EXTENTS, [
      block(400, 400, 600, 600),
      block(400, 400, 600, 600),
    ]);
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('binds every square to water a listener can hear it from', () => {
    const water = lattice([block(400, 400, 600, 600)]);
    const skin = terrainReflectors(grid, EXTENTS, [block(400, 400, 600, 600)]);
    expect(skin.length).toBeGreaterThan(0);
    for (const c of skin) {
      const p = visionCellCentre(grid, c);
      expect(water.water[water.waterIndexAt(p.x, p.y)]).toBe(1);
    }
  });
});

describe('the tuning it all runs on', () => {
  it('images at shorter range than it propagates, which is what bounds the sweep', () => {
    expect(ACOUSTICS.maxImagingRange).toBeLessThan(ACOUSTICS.maxRange);
  });

  it('keeps the lattice well inside the narrowest passage the generator will build', () => {
    // Detection is decided per lattice cell, so a cell comparable to a passage would quantize
    // away the passage. `minPassageWidth` is 200 m; ten cells across is ample.
    expect(ACOUSTICS.latticeCell * 8).toBeLessThanOrEqual(200);
  });

  it('reports the picture at a finer pitch than it decides detection on', () => {
    // The two resolutions do different jobs — the lattice decides *whether* a square is lit,
    // the skin decides *what shape* the light has — and that division only means anything
    // while the skin is the finer of the two. A vision square at or above the lattice pitch
    // would be a picture no more detailed than the answer behind it.
    expect(VISION_CELL_SIZE).toBeLessThan(ACOUSTICS.latticeCell);
  });

  it('keeps the smallest hull several squares across, so a contact is a shape not a mark', () => {
    // The binding constraint on `VISION_CELL_SIZE` going *up*. A Light is the thinnest thing
    // the picture ever has to draw, and past about four squares of beam its silhouette stops
    // being recognizable — which planning/03 §6 asks the player to do by eye.
    const light = getHull('light');
    const ys = light.silhouette.map(([, y]) => y);
    const beam = Math.max(...ys) - Math.min(...ys);

    expect(beam / VISION_CELL_SIZE).toBeGreaterThanOrEqual(4);
    expect(light.length / VISION_CELL_SIZE).toBeGreaterThanOrEqual(20);
  });
});
