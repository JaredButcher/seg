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
  ACOUSTIC_TICK_HZ,
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
  /**
   * How fast the fleet is moving, m/s — the knob that decides what the field cache is worth
   * (planning/16 §3.1.3).
   *
   * **Zero is not the neutral setting, it is the best case**: a stationary fleet never leaves its
   * lattice cells, so every solve after the first is a cache hit and the fields phase measures a
   * memcpy. Real content speeds are 12.5 m/s for a Heavy, 15 for a Light at flank, and 55 for a
   * super-cavitating torpedo — the last of which misses one solve in four. Quote a timing from a
   * moving fleet unless the point being made is explicitly the ceiling.
   */
  readonly speed: number;
  /**
   * Whether the field cache is on (planning/16 §3.1). `CACHE=0` turns it off, which is how the
   * before-and-after in §4 was measured: same fleet, same track, same map, one sweep policy apart.
   */
  readonly cache: boolean;
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
    speed: Number(process.env.SPEED ?? 12.5),
    cache: process.env.CACHE !== '0',
  };
}

/**
 * The fleet as it stands `solve` solves in, each entity drifting at `options.speed`.
 *
 * Directions are fixed per index — a benchmark whose workload wanders between runs cannot be
 * compared against itself — and the drift is bounced off the map edges rather than wrapped, so a
 * boat never teleports across the lattice and hands the cache a free miss.
 */
export function fleetAt(
  base: readonly AcousticEntity[],
  solve: number,
  options: BenchOptions,
  extents: { width: number; height: number },
): AcousticEntity[] {
  if (options.speed === 0) return [...base];

  const step = (options.speed / ACOUSTIC_TICK_HZ) * solve;
  return base.map((entity, i) => {
    const angle = (i * 2 * Math.PI) / 7;
    const bounce = (v: number, span: number): number => {
      const period = 2 * (span - 100);
      const at = ((((v - 50) % period) + period) % period) / 1;
      return 50 + (at < span - 100 ? at : period - at);
    };
    return {
      ...entity,
      pos: {
        x: bounce(entity.pos.x + step * Math.cos(angle), extents.width),
        y: bounce(entity.pos.y + step * Math.sin(angle), extents.height),
      },
    };
  });
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
    // A pinger's whole level is the pulse, so what deafens is that level skimmed by
    // `filterableNoiseFraction`. A quiet boat deafens with everything it has.
    deafeningLevel:
      i < options.pingers ? 90 + 10 * Math.log10(ACOUSTICS.filterableNoiseFraction) : 45,
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
