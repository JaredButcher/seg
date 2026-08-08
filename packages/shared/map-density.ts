import {
  buildSkeleton,
  carveField,
  extractObstacles,
  resolveExtents,
  resolveTuning,
  TerrainRuler,
  type CaveMapType,
  type CaveTuning,
  type MapSize,
} from './src/index.js';

function probe(type: CaveMapType, mapSize: MapSize, seed: number, overrides: Partial<CaveTuning>) {
  const tuning = resolveTuning(type, overrides);
  const extents = resolveExtents(mapSize);
  const skeleton = buildSkeleton(extents, tuning, seed);
  const field = carveField(extents, skeleton.stamps, tuning.cellSize);
  const obstacles = extractObstacles(field, extents, {
    simplifyTolerance: tuning.simplifyTolerance,
    minArea: tuning.nominalWallThickness * tuning.nominalWallThickness,
  });
  const ruler = new TerrainRuler(extents, obstacles, { cellSize: 8 });

  let solid = 0;
  let total = 0;
  for (let x = 50; x < extents.width; x += 150) {
    for (let y = 50; y < extents.height; y += 150) {
      total += 1;
      if (ruler.clearanceAt(x, y) <= 0) solid += 1;
    }
  }
  return {
    ok:
      ruler.hasOpeningAtLeast(tuning.minPassageWidth) &&
      ruler.hasRouteAtLeast(tuning.trunkPassageWidth),
    rock: solid / total,
    routes: skeleton.routes.length,
    obstacles: obstacles.length,
  };
}

const SEEDS = Array.from({ length: 120 }, (_, i) => i + 1);
const PLAN: [CaveMapType, number[]][] = [
  ['sparse', [5, 7, 8]],
  ['dense', [10, 12]],
];

for (const [type, counts] of PLAN) {
  for (const routeCount of counts) {
    const cells: string[] = [];
    for (const mapSize of ['small', 'medium', 'large'] as MapSize[]) {
      let failed = 0;
      let rock = 0;
      let routes = 0;
      let obstacles = 0;
      for (const seed of SEEDS) {
        const r = probe(type, mapSize, seed, { routeCount });
        if (!r.ok) failed += 1;
        rock += r.rock;
        routes += r.routes;
        obstacles += r.obstacles;
      }
      cells.push(
        `${mapSize.slice(0, 2)} ${failed}fail ${Math.round((rock / SEEDS.length) * 100)}%rock ` +
          `${(routes / SEEDS.length).toFixed(0)}rt ${(obstacles / SEEDS.length).toFixed(0)}ob`,
      );
    }
    console.log(`${type.padEnd(6)} asked ${String(routeCount).padStart(2)}   ${cells.join('  ')}`);
  }
}
