/**
 * The debug probe, measured against a running match (`MatchRuntime.probe`).
 *
 * The other two debug views draw a shape and leave the reading to the eye; this *is* the reading,
 * so what has to be pinned is that every figure on it is the figure the simulation would use. Two
 * of them are checked against the overlays that draw the same quantity — a probe and a field that
 * disagreed about one point would be worse than either alone, because the whole reason to have
 * both is to check one against the other.
 *
 * On a coarse lattice throughout (`MatchRuntimeOptions`), like the field tests beside it.
 */

import {
  ACOUSTICS,
  depthAt,
  deployMatch,
  fieldValueOf,
  generateMap,
  unpackFieldMap,
  type BoatTemplate,
  type DeployingPlayer,
  type EntityId,
  type MatchState,
  type Vec2,
} from '@seg/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { MatchRuntime } from '../src/match/runtime.js';

const BOAT: BoatTemplate = { name: 'S-01', hull: 'medium', modules: [] };

function seat(accountId: string, position: DeployingPlayer['position']): DeployingPlayer {
  return { accountId, username: accountId, position, boats: [BOAT] };
}

function match(mapType: 'empty' | 'dense' = 'empty'): MatchState {
  const state = deployMatch({
    matchId: 'm1',
    mode: 'deathmatch',
    map: generateMap(mapType, { seed: 11, mapSize: 'small' }),
    startedAt: 0,
    debugMode: true,
    players: [seat('host', 'team1'), seat('foe', 'team2')],
  });
  return {
    ...state,
    boats: state.boats.map((boat) =>
      boat.team === 'team1'
        ? { ...boat, pos: { x: 1000, y: 1000 }, facing: 0 }
        : { ...boat, pos: { x: 3000, y: 1000 }, facing: 180 },
    ),
  };
}

let runtime: MatchRuntime;
let mine: EntityId;

function settle(): void {
  for (let i = 0; i < 4; i += 1) runtime.tick();
}

function underWay(boat: EntityId, to: Vec2): void {
  runtime.setThrottle(boat, 'flank');
  runtime.order(boat, to, false);
  for (let i = 0; i < 80; i += 1) runtime.tick();
}

beforeEach(() => {
  runtime = new MatchRuntime(match(), { cellSize: 40, collisionCell: 40 });
  mine = runtime.state.boats.find((boat) => boat.team === 'team1')?.id ?? 0;
  settle();
});

describe('the point’s own readings', () => {
  it('answers about the point asked for, not the cell it landed in', () => {
    // The lattice is 40 m here, so a point 13 m into a cell would come back at the cell's centre
    // if this rounded — and a probe whose coordinates were not the ones clicked would be useless
    // for the one thing it is for: comparing two nearby points.
    const at = { x: 1013, y: 1007 };
    const reading = runtime.probe(mine, at);

    expect(reading?.at).toEqual(at);
    // The game's own depth for that y, not a second opinion about it (`map/sizes.ts`).
    expect(reading?.depth).toBeCloseTo(depthAt(runtime.state.map.extents, at.y), 6);
    expect(reading?.water).toBe(true);
  });

  it('reads louder water where a boat is running than across the map', () => {
    underWay(mine, { x: 1600, y: 1000 });
    const boat = runtime.state.boats.find((candidate) => candidate.id === mine)?.pos;
    if (boat === undefined) throw new Error('no boat');

    const near = runtime.probe(mine, { x: boat.x + 60, y: boat.y });
    const far = runtime.probe(mine, { x: 3400, y: 300 });

    expect(near?.noise ?? 0).toBeGreaterThan(far?.noise ?? 0);
    // The deafening half is never above the full reading, and the gap between them is the
    // filterable channel — which is all there is to see of it anywhere else.
    expect(near?.background ?? 0).toBeLessThanOrEqual(near?.noise ?? 0);
  });

  it('says when the point is rock, having read it at the water beside it', () => {
    runtime = new MatchRuntime(match('dense'), { cellSize: 40, collisionCell: 40 });
    const boat = runtime.state.boats.find((candidate) => candidate.team === 'team1');
    if (boat === undefined) throw new Error('no boat');
    settle();

    const lattice = runtime.state.map;
    // Any rock cell will do; the map generator decides where they are, so it is found rather than
    // assumed. A wall's *face* is lit through the water it fronts, which is what `water: false`
    // plus a real reading means (`WaterLattice.waterIndexAt`).
    //
    // Hunted with no listener named, which is the cheap half of a probe: the pair-wise half runs a
    // Dijkstra out of the boat and a sweep per candidate point would be a minute of them.
    let rock: Vec2 | null = null;
    for (let y = 40; y < lattice.extents.height && rock === null; y += 40) {
      for (let x = 40; x < lattice.extents.width; x += 40) {
        const point = { x, y };
        if (runtime.probe(null, point)?.water === false) {
          rock = point;
          break;
        }
      }
    }

    expect(rock).not.toBeNull();
    const reading = rock === null ? null : runtime.probe(boat.id, rock);
    expect(reading?.water).toBe(false);
    // Still a real reading, taken at a real cell.
    expect(reading?.cell).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(reading?.noise ?? NaN)).toBe(true);
  });

  it('refuses a point off the map, and a match before its first solve', () => {
    expect(runtime.probe(mine, { x: -10, y: 1000 })).toBeNull();
    expect(runtime.probe(mine, { x: 99_999, y: 1000 })).toBeNull();

    const fresh = new MatchRuntime(match(), { cellSize: 40, collisionCell: 40 });
    expect(fresh.probe(mine, { x: 1000, y: 1000 })).toBeNull();
  });
});

describe('the listener half', () => {
  it('is skipped for no boat, a boat that is not there, and one that has sunk', () => {
    // The water's own numbers do not need anybody to be listening, so the reading still lands.
    expect(runtime.probe(null, { x: 1500, y: 1000 })?.listener).toBeNull();
    expect(runtime.probe(9999, { x: 1500, y: 1000 })?.listener).toBeNull();
    expect(runtime.probe(null, { x: 1500, y: 1000 })?.noise).toBeDefined();

    runtime.replace({
      ...runtime.state,
      boats: runtime.state.boats.map((boat) =>
        boat.id === mine ? { ...boat, hp: 0, status: 'destroyed' } : boat,
      ),
    });
    expect(runtime.probe(mine, { x: 1500, y: 1000 })?.listener).toBeNull();
  });

  it('agrees with the detect overlay about how loud a source would have to be', () => {
    // The cross-check that matters: `seg.field('detect')` and the probe are two readings of one
    // quantity, and a developer comparing a click against the colour under it has to find the same
    // answer. Quantization is the only difference allowed — the field is packed into buckets.
    const point = { x: 1800, y: 1000 };
    const map = runtime.fieldMap('detect', mine);
    const reading = runtime.probe(mine, point);
    if (map === null || reading?.listener == null) throw new Error('no reading');

    const samples = unpackFieldMap(map);
    const col = Math.floor(point.x / map.sampleSize);
    const row = Math.floor(point.y / map.sampleSize);
    const drawn = fieldValueOf(map, samples[row * map.cols + col] ?? 0);

    expect(drawn).not.toBeNull();
    // Within one bucket of the ramp, plus the block the sample was aggregated over.
    expect(Math.abs((drawn ?? 0) - (reading.listener.audible ?? 0))).toBeLessThan(map.step * 2);
  });

  it('is the gate plus the path, and the gate rises when the listener gets noisy', () => {
    const point = { x: 1800, y: 1000 };
    const quiet = runtime.probe(mine, point)?.listener;
    if (quiet == null || quiet.range === null) throw new Error('no reading');

    // The identity the panel is read through: what a source has to beat is this boat's gate plus
    // whatever the path costs, and nothing else.
    expect(quiet.audible).toBeCloseTo(quiet.gate + (quiet.loss ?? 0), 6);
    // And the floor the gate is built on: `returnThreshold` is floor + DT − array gain.
    expect(quiet.gate).toBeCloseTo(
      quiet.floor + ACOUSTICS.detectionThreshold - (runtime.state.boats[0]?.stats.arrayGain ?? 0),
      6,
    );

    underWay(mine, { x: 1600, y: 1000 });
    const loud = runtime.probe(mine, point)?.listener;
    expect(loud?.selfNoise ?? 0).toBeGreaterThan(quiet.selfNoise);
    expect(loud?.floor ?? 0).toBeGreaterThan(quiet.floor);
    expect(loud?.audible ?? 0).toBeGreaterThan(quiet.audible ?? 0);
  });

  it('measures the way sound swims rather than the way a ruler points', () => {
    runtime = new MatchRuntime(match('dense'), { cellSize: 40, collisionCell: 40 });
    const boat = runtime.state.boats.find((candidate) => candidate.team === 'team1');
    if (boat === undefined) throw new Error('no boat');
    settle();

    // The point is found off the range overlay and probed after, rather than probing the whole
    // map: every pair-wise reading is its own Dijkstra out of the boat, which is the honest cost
    // of a click and an absurd one for sixteen thousand of them.
    const map = runtime.fieldMap('range', boat.id);
    if (map === null) throw new Error('no field');
    const samples = unpackFieldMap(map);

    let bent: Vec2 | null = null;
    for (let i = 0; i < samples.length && bent === null; i += 1) {
      const col = i % map.cols;
      const row = (i - col) / map.cols;
      const point = { x: (col + 0.5) * map.sampleSize, y: (row + 0.5) * map.sampleSize };
      const straight = Math.hypot(point.x - boat.pos.x, point.y - boat.pos.y);
      if (straight <= map.sampleSize * 4) continue;
      const swum = fieldValueOf(map, samples[i] ?? 0);
      if (swum !== null && swum > straight * 1.3) bent = point;
    }
    if (bent === null) throw new Error('the map bent no paths');

    const around = runtime.probe(boat.id, bent)?.listener;
    expect(around?.range ?? 0).toBeGreaterThan((around?.straight ?? 0) * 1.2);
    expect(around?.loss ?? 0).toBeGreaterThan(0);
  });

  it('says so when sound cannot get there at all, rather than saying zero', () => {
    // Forced with a tuning rather than hunted for on a map: what is being pinned is what the panel
    // does with *no path*, and a fixture that depended on the generator leaving a sealed pocket
    // somewhere would be a test about map generation.
    runtime = new MatchRuntime(match(), {
      cellSize: 40,
      collisionCell: 40,
      tuning: { ...ACOUSTICS, maxRange: 300 },
    });
    mine = runtime.state.boats.find((boat) => boat.team === 'team1')?.id ?? 0;
    settle();

    const near = runtime.probe(mine, { x: 1150, y: 1000 })?.listener;
    expect(near?.range ?? 0).toBeGreaterThan(0);

    const beyond = runtime.probe(mine, { x: 2400, y: 1000 })?.listener;
    expect(beyond).not.toBeNull();
    expect(beyond?.range).toBeNull();
    // Everything downstream of a path that does not exist is absent rather than zero — the one
    // mistake this panel could make that would matter is reading "no path" as "no distance".
    expect(beyond?.loss).toBeNull();
    expect(beyond?.audible).toBeNull();
    expect(beyond?.imaging).toBeNull();
    // The listener's own figures are still there: it has a floor wherever it is standing, and a
    // straight-line distance to the point is a fact about a ruler rather than about the water.
    expect(Number.isFinite(beyond?.floor ?? NaN)).toBe(true);
    expect(beyond?.straight ?? 0).toBeGreaterThan(1000);
  });

  it('reports imaging only where a return would clear the threshold', () => {
    underWay(mine, { x: 1600, y: 1000 });
    const boat = runtime.state.boats.find((candidate) => candidate.id === mine)?.pos;
    if (boat === undefined) throw new Error('no boat');

    // Close in, the boat is lighting the water with its own racket.
    expect(runtime.probe(mine, { x: boat.x + 80, y: boat.y })?.listener?.imaging).not.toBeNull();
    // Across the map, the return is water it is lighting too faintly to get an answer back from —
    // which is *absent* rather than a low reading, the same rule the imaging overlay draws by.
    expect(runtime.probe(mine, { x: 3400, y: 300 })?.listener?.imaging).toBeNull();
  });
});
