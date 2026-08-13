/**
 * The four debug acoustic fields, measured against a running match.
 *
 * `match-field` in `@seg/shared` proves the codec; this proves the *physics reaches it* — that
 * `noise` is loud where the boat is, that `detect` says a quiet hull has to be closer than a loud
 * one, that `imaging` stops where the solver stops imaging, and that `range` bends around rock
 * instead of through it. Those are the claims a developer reads an overlay for, and none of them
 * is visible in the payload's arithmetic.
 *
 * On a coarse lattice throughout (`MatchRuntimeOptions`), because every assertion here is about
 * the shape of an answer rather than about how finely the ocean was rasterized.
 */

import {
  deployMatch,
  generateMap,
  getHull,
  fieldValueOf,
  unpackFieldMap,
  FIELD_SPECS,
  type BoatTemplate,
  type DeployingPlayer,
  type EntityId,
  type FieldMapView,
  type MatchState,
  type Vec2,
} from '@seg/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { MatchRuntime } from '../src/match/runtime.js';

const BOAT: BoatTemplate = { name: 'S-01', hull: 'medium', modules: [] };

function seat(accountId: string, position: DeployingPlayer['position']): DeployingPlayer {
  return { accountId, username: accountId, position, boats: [BOAT] };
}

/** Two boats a long way apart on an empty map, so the water between them is the only variable. */
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

/** Run until a solve has happened, which is what every field is measured off. */
function settle(): void {
  for (let i = 0; i < 4; i += 1) runtime.tick();
}

/**
 * Get a boat genuinely running at flank, and leave it there.
 *
 * An order as well as a throttle: a boat holding station decelerates whatever notch it is on
 * (`match/movement.ts`), so a throttle alone would leave it at rest and every assertion about
 * self-noise or radiated noise would be measuring nothing.
 */
function underWay(boat: EntityId, to: Vec2): void {
  runtime.setThrottle(boat, 'flank');
  runtime.order(boat, to, false);
  for (let i = 0; i < 80; i += 1) runtime.tick();
}

/**
 * Put the other boat `metres` away with a collision ringing on it, as of this tick.
 *
 * A transient rather than a throttle, because a transient is the case the instantaneous overlay
 * could not see: it is loudest the tick it lands and linearly quieter every tick after
 * (`content/acoustics.ts#transientLevel`), so what a frame reports depends entirely on which tick
 * it was packed on.
 */
function bang(metres: number): void {
  const tick = runtime.state.clock.tick;
  runtime.replace({
    ...runtime.state,
    boats: runtime.state.boats.map((boat) =>
      boat.id === mine
        ? boat
        : {
            ...boat,
            pos: { x: 1000 + metres, y: 1000 },
            transients: [{ kind: 'collision', tick }],
          },
    ),
  });
}

/**
 * One overlay frame of our boat's `detect`: the ten ticks between sends, then the send.
 *
 * The publishing loop's cadence rather than a bare `fieldMap` call, because for a `peak` field the
 * two are not the same thing — the send is what closes a window, so a test that ticks for six
 * seconds and then asks once has handed the frame a six-second window nobody would ever see.
 */
function frame(): FieldMapView {
  for (let i = 0; i < 10; i += 1) runtime.tick();
  const map = runtime.fieldMap('detect', mine);
  if (map === null) throw new Error('no field');
  return map;
}

beforeEach(() => {
  runtime = new MatchRuntime(match(), { cellSize: 40, collisionCell: 40 });
  mine = runtime.state.boats.find((boat) => boat.team === 'team1')?.id ?? 0;
  settle();
});

/** The value a packed field reports at a point on the map, or `null` where it has no reading. */
function at(map: FieldMapView, point: Vec2): number | null {
  const samples = unpackFieldMap(map);
  const col = Math.min(map.cols - 1, Math.max(0, Math.floor(point.x / map.sampleSize)));
  const row = Math.min(map.rows - 1, Math.max(0, Math.floor(point.y / map.sampleSize)));
  return fieldValueOf(map, samples[row * map.cols + col] ?? 0);
}

describe('the noise field', () => {
  it('is loud where a boat is running and empty at the far end of the map', () => {
    underWay(mine, { x: 1600, y: 1000 });

    const map = runtime.fieldMap('noise', null);
    if (map === null) throw new Error('no field');
    expect(map.kind).toBe('noise');
    expect(map.unit).toBe('dB');

    const boat = runtime.state.boats.find((candidate) => candidate.id === mine);
    expect(boat?.speed ?? 0).toBeGreaterThan(1);
    const loud = at(map, boat?.pos ?? { x: 1000, y: 1000 });
    expect(loud ?? 0).toBeGreaterThan(40);
    // Falls off with distance, and is gone entirely long before the map runs out — the sea itself
    // is *absent* rather than a dark wash (`match/field.ts`).
    const far = at(map, { x: 3400, y: 300 });
    expect(far === null || far < (loud ?? 0)).toBe(true);
  });

  it('needs no boat, unlike the three that ask about a hydrophone', () => {
    expect(runtime.fieldMap('noise', null)).not.toBeNull();
  });
});

describe('the minimum-audible-source-level field', () => {
  it('rises with range, so a quieter hull has to be closer to be heard', () => {
    const map = runtime.fieldMap('detect', mine);
    if (map === null) throw new Error('no field');
    expect(map.kind).toBe('detect');
    expect(map.label).toBe(FIELD_SPECS.detect.label);

    const near = at(map, { x: 1300, y: 1000 });
    const mid = at(map, { x: 2000, y: 1000 });
    expect(near).not.toBeNull();
    expect(mid).not.toBeNull();
    expect(mid ?? 0).toBeGreaterThan(near ?? 0);

    // The reading a developer actually takes off this overlay: the Light radiates 41 dB at rest,
    // so water reading under that is water a Light could not sit quietly in unseen.
    const light = getHull('light').stats.sourceLevel;
    expect(near ?? 0).toBeLessThan(light + FIELD_SPECS.detect.max);
  });

  it('moves when the listener gets noisier, because the floor it is measured against does', () => {
    // The whole reason this is not a relabelled range plot: it is read against the boat's *real*
    // noise floor, so going to flank — which is 30 dB of self-noise (`selfNoiseSpan`) — visibly
    // costs it hearing.
    const quiet = runtime.fieldMap('detect', mine);
    underWay(mine, { x: 1600, y: 1000 });
    const loud = runtime.fieldMap('detect', mine);

    if (quiet === null || loud === null) throw new Error('no field');
    // Read 800 m out rather than at the hull: close in, the answer is far below the bottom of the
    // ramp and both frames clamp to it, which is correct and says nothing. `selfNoiseSpan` is
    // 30 dB across the throttle range, so the shift out here is unmistakable.
    const point = { x: 1800, y: 1000 };
    expect(at(quiet, point) ?? 0).toBeGreaterThan(FIELD_SPECS.detect.min);
    expect(at(loud, point) ?? 0).toBeGreaterThan((at(quiet, point) ?? 0) + 5);
  });

  it("carries the window's worst gate, so a bang between two frames still deafens one", () => {
    // The whole of the `peak` window (`match/field.ts`): a frame goes out twice a second, the
    // acoustics solve ten times a second, and the events worth watching this overlay for — a
    // pulse, a hull hitting rock — are loudest the tick they land and are decaying from then on.
    // Sampled at the instant a frame is packed, the deafening a developer went looking for was
    // simply never in one.
    runtime.setDebugField('host', 'detect', mine);
    const point = { x: 1800, y: 1000 };
    const quiet = runtime.fieldMap('detect', mine);

    bang(1200);
    // One frame's worth of ticks, so the bang rings through five solves and is a fifth of the way
    // down by the one that publishes.
    for (let i = 0; i < 10; i += 1) runtime.tick();

    const frame = runtime.fieldMap('detect', mine);
    // The same measurement with the window already spent, which is exactly what the overlay used
    // to report — and the point of the change is that the two differ.
    const instant = runtime.fieldMap('detect', mine);
    if (quiet === null || frame === null || instant === null) throw new Error('no field');

    expect(at(frame, point) ?? 0).toBeGreaterThan((at(instant, point) ?? 0) + 2);
    expect(at(instant, point) ?? 0).toBeGreaterThan(at(quiet, point) ?? 0);
  });

  it('lets the window go once the water is quiet again', () => {
    // The other half of it. A peak that stuck would turn the overlay into a high-water mark for
    // the rest of the match, which is a worse instrument than the one that missed the bang.
    runtime.setDebugField('host', 'detect', mine);
    const point = { x: 1800, y: 1000 };
    runtime.fieldMap('detect', mine);

    bang(1200);
    const loud = frame();
    // Past the five seconds a collision rings for (`TRANSIENTS`), a frame at a time, so each
    // window is offered only the water the one before it left.
    let settled = loud;
    for (let i = 0; i < 12; i += 1) settled = frame();

    expect(at(settled, point) ?? 0).toBeLessThan(at(loud, point) ?? 0);
    // And stays there: the window that follows a quiet one reads the same.
    expect(at(frame(), point)).toBe(at(settled, point));
  });

  it('refuses a boat that is not there, and one that has sunk', () => {
    expect(runtime.fieldMap('detect', null)).toBeNull();
    expect(runtime.fieldMap('detect', 9999)).toBeNull();

    const wreck = runtime.state.boats.find((boat) => boat.id === mine);
    if (wreck === undefined) throw new Error('no boat');
    runtime.replace({
      ...runtime.state,
      boats: runtime.state.boats.map((boat) =>
        boat.id === mine ? { ...boat, hp: 0, status: 'destroyed' } : boat,
      ),
    });
    expect(runtime.fieldMap('detect', mine)).toBeNull();
  });
});

describe('the imaging field', () => {
  it('reaches out from the boat and stops where the solver stops imaging', () => {
    underWay(mine, { x: 1600, y: 1000 });

    const map = runtime.fieldMap('imaging', mine);
    if (map === null) throw new Error('no field');
    expect(map.kind).toBe('imaging');

    // Something is lit near the boat — it is the loudest thing in this water and it is lighting
    // the sea around itself.
    const boat = runtime.state.boats.find((candidate) => candidate.id === mine);
    expect(at(map, boat?.pos ?? { x: 0, y: 0 })).not.toBeNull();
    // And nothing at all across the map: reflections pay the path twice, so the imaging picture
    // is short-ranged by construction and `maxImagingRange` is where it is cut.
    expect(at(map, { x: 3000, y: 1000 })).toBeNull();
  });

  it('is a different question from hearing: it grows when the boat gets louder', () => {
    // A boat images with its *own* racket, so going to flank buys it sight at the same moment it
    // costs it hearing — the trade `solve.ts` says falls out of the model rather than being
    // designed in. This is that trade, visible.
    const quiet = runtime.fieldMap('imaging', mine);
    underWay(mine, { x: 1600, y: 1000 });
    const loud = runtime.fieldMap('imaging', mine);

    if (quiet === null || loud === null) throw new Error('no field');
    const lit = (map: FieldMapView): number =>
      [...unpackFieldMap(map)].filter((bucket) => bucket > 0).length;
    expect(lit(loud)).toBeGreaterThan(lit(quiet));
  });
});

describe('the range field', () => {
  it('grows with distance from the boat, in metres', () => {
    const map = runtime.fieldMap('range', mine);
    if (map === null) throw new Error('no field');
    expect(map.kind).toBe('range');
    expect(map.unit).toBe('m');

    const near = at(map, { x: 1200, y: 1000 }) ?? 0;
    const far = at(map, { x: 2200, y: 1000 }) ?? 0;
    expect(near).toBeLessThan(far);
    // Roughly the straight-line distance on an empty map, within the octagon error and a bucket.
    expect(far - near).toBeGreaterThan(700);
  });

  it('measures the way sound swims rather than the way a ruler points', () => {
    // The propagation model's whole claim, drawn: on a map full of rock the geodesic path to a
    // point behind a wall is longer than the straight line to it, and some water is not reachable
    // at all. A field that reported Euclidean distance would have no reading anywhere near this.
    runtime = new MatchRuntime(match('dense'), { cellSize: 40, collisionCell: 40 });
    const boat = runtime.state.boats.find((candidate) => candidate.team === 'team1');
    if (boat === undefined) throw new Error('no boat');
    settle();

    const map = runtime.fieldMap('range', boat.id);
    if (map === null) throw new Error('no field');

    let bent = 0;
    let unreachable = 0;
    const samples = unpackFieldMap(map);
    for (let i = 0; i < samples.length; i += 1) {
      const col = i % map.cols;
      const row = (i - col) / map.cols;
      const point = { x: (col + 0.5) * map.sampleSize, y: (row + 0.5) * map.sampleSize };
      const straight = Math.hypot(point.x - boat.pos.x, point.y - boat.pos.y);
      if (straight > map.sampleSize * 4) {
        const swum = fieldValueOf(map, samples[i] ?? 0);
        if (swum === null) unreachable += 1;
        else if (swum > straight * 1.2) bent += 1;
      }
    }

    expect(bent).toBeGreaterThan(0);
    expect(unreachable).toBeGreaterThan(0);
  });
});
