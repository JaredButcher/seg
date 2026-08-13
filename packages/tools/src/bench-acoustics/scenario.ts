/**
 * The fleet the acoustic benchmarks measure, and the knobs that shape it.
 *
 * Shared by every probe in this directory so that two of them quoting a cell count are quoting
 * the same one. Everything is deterministic — a fixed seed, entities laid out by index rather
 * than by dice — because a benchmark whose *workload* moves between runs cannot be compared
 * against itself a month later, which is the entire point of checking these in.
 */

import {
  ACOUSTICS,
  generateMap,
  getHull,
  hullOutline,
  isMapSize,
  type AcousticEntity,
  type GeneratedMap,
  type MapSize,
  type MapType,
  type WaterLattice,
} from '@seg/shared';

export interface BenchOptions {
  readonly mapType: MapType;
  readonly mapSize: MapSize;
  readonly seed: number;
  /** Entities in the water. Fleets are 3–5 boats a side in practice (planning/README §6). */
  readonly fleet: number;
  /** How many of them are mid-pulse — the most expensive thing one boat can ask for. */
  readonly pingers: number;
  readonly runs: number;
}

const MAP_TYPES = new Set<string>(['empty', 'dense', 'caves']);

/** Reads the options out of the environment, so one script covers every scenario. */
export function optionsFromEnv(): BenchOptions {
  const mapType = process.env.MAP ?? 'dense';
  const mapSize = process.env.SIZE ?? 'medium';
  return {
    mapType: (MAP_TYPES.has(mapType) ? mapType : 'dense') as MapType,
    mapSize: isMapSize(mapSize) ? mapSize : 'medium',
    seed: Number(process.env.SEED ?? 11),
    fleet: Number(process.env.FLEET ?? 8),
    pingers: Number(process.env.PINGERS ?? 1),
    runs: Number(process.env.RUNS ?? 20),
  };
}

export function benchMap(options: BenchOptions): GeneratedMap {
  return generateMap(options.mapType, { seed: options.seed, mapSize: options.mapSize });
}

/** Every water cell on the lattice, in index order. The spread of entities is taken from this. */
export function waterCells(lattice: WaterLattice): number[] {
  const cells: number[] = [];
  for (let i = 0; i < lattice.cellCount; i += 1) if (lattice.water[i] === 1) cells.push(i);
  return cells;
}

/**
 * `count` positions spread evenly through the water, by index rather than by geometry.
 *
 * Index order snakes along rows, so an even spread through it is an even spread across the map's
 * *width* — which is the axis a fleet actually spreads along.
 */
export function spread(lattice: WaterLattice, count: number): { x: number; y: number }[] {
  const cells = waterCells(lattice);
  return Array.from({ length: count }, (_, i) => {
    const at = Math.floor((i / Math.max(1, count)) * cells.length * 0.97);
    return lattice.centreOf(cells[at] ?? 0);
  });
}

/**
 * A fleet of medium hulls, half to each team, the first `pingers` of them mid-pulse.
 *
 * A quiet boat is given `45 dB`, which is roughly a cruising hull off `emittedLevels` — chosen
 * because its emission reach (`870 m`) lands *under* `maxImagingRange`, so the fleet measures the
 * common case where the imaging floor is what sizes every field.
 */
export function benchFleet(lattice: WaterLattice, options: BenchOptions): AcousticEntity[] {
  const hull = getHull('medium');
  return spread(lattice, options.fleet).map((pos, i) => ({
    id: i + 1,
    team: i % 2 === 0 ? ('team1' as const) : ('team2' as const),
    pos,
    sourceLevel: i < options.pingers ? 90 : 45,
    filterableLevel: i < options.pingers ? 90 : -Infinity,
    absorption: ACOUSTICS.hullAbsorption,
    outline: hullOutline(hull, pos, 0),
    hydrophone: { gain: 20, selfNoise: 10 },
  }));
}

export function describe(map: GeneratedMap, lattice: WaterLattice, o: BenchOptions): string {
  let water = 0;
  for (let i = 0; i < lattice.cellCount; i += 1) water += lattice.water[i] ?? 0;
  return (
    `map=${o.mapType}/${o.mapSize} seed=${o.seed} ${map.extents.width}x${map.extents.height} m  ` +
    `lattice=${lattice.cols}x${lattice.rows}=${lattice.cellCount} cells (${water} water)  ` +
    `fleet=${o.fleet} pingers=${o.pingers}`
  );
}
