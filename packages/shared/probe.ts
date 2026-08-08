import {
  buildSkeleton,
  carveField,
  extractObstacles,
  resolveExtents,
  resolveTuning,
  TerrainRuler,
  type CaveMapType,
  type MapSize,
} from './src/index.js';

const CELL = 4;

/** Free cells the opening test genuinely rejects, found by exact local search. */
function offenders(type: CaveMapType, mapSize: MapSize, seed: number) {
  const tuning = resolveTuning(type);
  const extents = resolveExtents(mapSize);
  const skeleton = buildSkeleton(extents, tuning, seed);
  const field = carveField(extents, skeleton.stamps, tuning.cellSize);
  const obstacles = extractObstacles(field, extents, {
    simplifyTolerance: tuning.simplifyTolerance,
    minArea: tuning.nominalWallThickness * tuning.nominalWallThickness,
  });
  const ruler = new TerrainRuler(extents, obstacles, { cellSize: CELL });

  const w = tuning.minPassageWidth;
  const reach = w / 2;
  const span = Math.ceil(reach / CELL);
  const bad: { x: number; y: number }[] = [];

  for (let x = CELL / 2; x < extents.width; x += CELL) {
    for (let y = CELL / 2; y < extents.height; y += CELL) {
      if (ruler.clearanceAt(x, y) <= 0) continue;
      if (ruler.clearanceAt(x, y) >= w) continue;

      let covered = false;
      for (let dx = -span; dx <= span && !covered; dx += 1) {
        for (let dy = -span; dy <= span; dy += 1) {
          if (dx * dx + dy * dy > span * span) continue;
          if (ruler.clearanceAt(x + dx * CELL, y + dy * CELL) >= w) {
            covered = true;
            break;
          }
        }
      }
      if (!covered) bad.push({ x, y });
    }
  }
  return { bad, extents, skeleton };
}

for (const [type, size, seed] of [
  ['sparse', 'small', 1],
  ['dense', 'medium', 197],
] as [CaveMapType, MapSize, number][]) {
  const { bad, extents, skeleton } = offenders(type, size, seed);
  console.log(`\n${type} ${size} seed ${seed}  ${extents.width}x${extents.height}: ${bad.length} rejected cells`);

  // Cluster them roughly, so the output names places rather than listing pixels.
  const seen: { x: number; y: number; n: number }[] = [];
  for (const p of bad) {
    const near = seen.find((c) => Math.abs(c.x - p.x) < 300 && Math.abs(c.y - p.y) < 300);
    if (near === undefined) seen.push({ ...p, n: 1 });
    else near.n += 1;
  }
  for (const c of seen.sort((a, b) => b.n - a.n).slice(0, 6)) {
    const routeYs = skeleton.routes.map((r) => Math.round(r.yAt(c.x)));
    console.log(
      `   around x ${Math.round(c.x)} y ${Math.round(c.y)} (${c.n} cells); route centres there: ${routeYs.join(', ')}`,
    );
  }
}
