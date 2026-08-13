/**
 * The claim the field cache rests on, checked rather than argued (planning/16 §3.1).
 *
 * > A field's ranges are exactly `seed + graphDistance(startCell, cell)`, and the graph distance
 * > depends only on *which cell* the source is in — not on where inside that cell it sits.
 *
 * If that holds, a field is a pure function of `(startCell, radius)` plus one scalar, the lattice
 * never changes after match start, and a boat that has not left its cell since the last solve does
 * not need a new sweep. The whole of §3.1 is downstream of this script.
 *
 * It also prints how long an entity *stays* in a cell, which is what turns the invariant into a
 * hit rate: the invariant says a cache is possible, the dwell time says whether it is worth it.
 *
 *   pnpm bench:acoustics:invariant
 *   MAP=caves SIZE=large pnpm bench:acoustics:invariant
 */

import { ACOUSTICS, ACOUSTIC_TICK_HZ, FieldArena, WaterLattice } from '@seg/shared';

import { benchMap, optionsFromEnv, waterCells } from './scenario.js';

const options = optionsFromEnv();
const map = benchMap(options);
const lattice = new WaterLattice(map.extents, map.terrain.obstacles, {
  cellSize: ACOUSTICS.latticeCell,
});
const arena = new FieldArena(lattice);

function fieldAt(x: number, y: number, maxRange: number): Map<number, number> {
  arena.reset();
  const field = arena.solve(x, y, { maxRange, maxCells: 1e9 });
  const out = new Map<number, number>();
  for (let i = 0; i < field.count; i += 1) out.set(arena.cellAt(field, i), arena.rangeAt(field, i));
  return out;
}

// Offsets inside one cell, in metres. The last pair sits nearly in a corner, which is the worst
// case for the claim: the seed is at its largest and the nearest neighbours are least symmetric.
const OFFSETS = [
  [0, 0],
  [6, 0],
  [-7, 4],
  [9, -9],
  [-9.5, -9.5],
] as const;

const cells = waterCells(lattice);
const starts = [0.03, 0.2, 0.5, 0.77, 0.95].map((f) => cells[Math.floor(f * cells.length)] ?? 0);

let checked = 0;
let worst = 0;
let worstAt = -1;

for (const start of starts) {
  const centre = lattice.centreOf(start);
  // Seeded at the cell centre, the ranges *are* the graph distances: the seed is zero.
  const graph = fieldAt(centre.x, centre.y, ACOUSTICS.maxRange);

  for (const [dx, dy] of OFFSETS) {
    const x = centre.x + dx;
    const y = centre.y + dy;
    // Only meaningful while the offset has not moved the source into a different cell.
    if (lattice.waterIndexAt(x, y) !== start) continue;
    const seed = Math.hypot(dx, dy);
    // Bounded short of `maxRange` so the seed shift cannot clip a cell the reference kept.
    const shifted = fieldAt(x, y, ACOUSTICS.maxRange - 100);

    for (const [cell, range] of shifted) {
      const expected = (graph.get(cell) ?? NaN) + seed;
      const deviation = Math.abs(range - expected);
      if (deviation > worst) {
        worst = deviation;
        worstAt = cell;
      }
      checked += 1;
    }
  }
}

console.log(
  `${checked} cell-ranges checked across ${starts.length} start cells and ${OFFSETS.length} offsets\n` +
    `worst deviation from seed + graphDistance: ${worst.toExponential(3)} m (cell ${worstAt})\n`,
);

// A metre of deviation would be a different field. Anything at 1e-9 is float noise in the last
// bits — real, and the reason §3.1 insists the seed be added on the hit path *and* the miss path.
if (worst > 1e-9) {
  console.log('FAILS — the field is not a pure function of its start cell. §3.1 does not hold.');
  process.exitCode = 1;
} else {
  console.log('HOLDS — a field is a pure function of its start cell, plus a scalar.');
}

console.log(`\nhow long an entity stays in one ${ACOUSTICS.latticeCell} m cell:`);
for (const speed of [5, 10, 12.5, 15, 22, 55]) {
  const seconds = ACOUSTICS.latticeCell / speed;
  const solves = seconds * ACOUSTIC_TICK_HZ;
  console.log(
    `  ${String(speed).padStart(4)} m/s  ${(speed / ACOUSTIC_TICK_HZ).toFixed(2)} m per solve  ` +
      `crosses a cell every ${seconds.toFixed(2)} s = ${solves.toFixed(0)} solves  ` +
      `(${(100 * (1 - 1 / solves)).toFixed(0)}% hit rate)`,
  );
}
