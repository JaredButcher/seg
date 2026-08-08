/**
 * Deployment: fleets on the map, and the properties a match start must not get wrong.
 *
 * The one that matters most is "in the water". A boat placed inside rock is invisible to the
 * player as a bug — it renders fine, it just cannot move — so it is asserted against the same
 * ruler the map generator's own guarantees are measured with, on carved maps rather than only
 * on open water.
 */

import {
  BASE_MAP_HEIGHT,
  BASE_MAP_WIDTH,
  DEFAULT_WEAPON,
  MAP_DEPTH,
  MAP_SIZES,
  TerrainRuler,
  boatsOnTeam,
  boatsOwnedBy,
  deployMatch,
  deploymentBands,
  depthAt,
  generateMap,
  getHull,
  startingFacing,
  type BoatTemplate,
  type DeployingPlayer,
  type GeneratedMap,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

const LIGHT: BoatTemplate = { name: 'S-01', hull: 'light', modules: [] };
const HEAVY: BoatTemplate = { name: 'S-02', hull: 'heavy', modules: [] };

function player(
  accountId: string,
  position: DeployingPlayer['position'],
  boats: readonly BoatTemplate[],
): DeployingPlayer {
  return { accountId, username: accountId, position, boats };
}

function deploy(map: GeneratedMap, players?: readonly DeployingPlayer[]) {
  return deployMatch({
    matchId: 'm1',
    mode: 'objective-capture',
    map,
    startedAt: 1_000,
    players: players ?? [
      player('host', 'team1', [LIGHT, HEAVY]),
      player('guest', 'team2', [LIGHT, HEAVY]),
    ],
  });
}

const EMPTY = generateMap('empty', { seed: 1, mapSize: 'medium' });
const DENSE = generateMap('dense', { seed: 7, mapSize: 'medium' });

describe('deployment bands', () => {
  it('gives each team an equal slab at its own end', () => {
    const bands = deploymentBands({ width: BASE_MAP_WIDTH, height: BASE_MAP_HEIGHT });

    expect(bands.team1.x0).toBe(0);
    expect(bands.team2.x1).toBe(BASE_MAP_WIDTH);
    expect(bands.team1.x1 - bands.team1.x0).toBeCloseTo(bands.team2.x1 - bands.team2.x0);
  });

  it('points each team at the rest of the map', () => {
    expect(startingFacing('team1')).toBe(0);
    expect(startingFacing('team2')).toBe(180);
  });
});

describe('deployMatch', () => {
  it('puts every boat on the map, on its owner’s side, in its own band', () => {
    const state = deploy(EMPTY);
    const bands = deploymentBands(EMPTY.extents);

    expect(state.boats).toHaveLength(4);
    for (const boat of state.boats) {
      const band = bands[boat.team];
      expect(boat.pos.x).toBeGreaterThanOrEqual(band.x0);
      expect(boat.pos.x).toBeLessThanOrEqual(band.x1);
      expect(boat.facing).toBe(startingFacing(boat.team));
    }
  });

  it('starts every boat stopped, whole, and loaded', () => {
    const state = deploy(EMPTY);

    for (const boat of state.boats) {
      expect(boat.speed).toBe(0);
      expect(boat.throttle).toBe('stop');
      expect(boat.hp).toBe(boat.stats.maxHp);
      expect(boat.status).toBe('active');
      expect(boat.order).toEqual({ kind: 'hold' });
      expect(boat.tubes).toHaveLength(boat.stats.torpedoTubes);
      expect(boat.tubes.every((tube) => tube.status === 'loaded')).toBe(true);
      expect(boat.tubes.every((tube) => tube.weapon === DEFAULT_WEAPON)).toBe(true);
      // Numbered from zero, in order, so the fleet list's pips match the boat's tubes.
      expect(boat.tubes.map((tube) => tube.index)).toEqual(boat.tubes.map((_, index) => index));
    }
  });

  it('places every boat in water wide enough to sit in, even on a carved map', () => {
    const state = deploy(DENSE);
    const ruler = new TerrainRuler(DENSE.extents, DENSE.terrain.obstacles);

    for (const boat of state.boats) {
      const clearance = ruler.clearanceAt(boat.pos.x, boat.pos.y);
      expect(clearance).toBeGreaterThan(0);
      // And not merely "not inside rock" — the hull has to fit, with room to manoeuvre.
      expect(clearance).toBeGreaterThanOrEqual(getHull(boat.hull).clearanceRadius * 2);
    }
  });

  it('spreads a fleet down the water column rather than stacking it', () => {
    const state = deploy(EMPTY);
    const depths = state.boats
      .filter((boat) => boat.team === 'team1')
      .map((boat) => depthAt(EMPTY.extents, boat.pos.y));

    expect(new Set(depths).size).toBe(depths.length);
    // Never at the surface and never on the seabed: both are hard boundaries (planning/04 §6).
    for (const depth of depths) {
      expect(depth).toBeGreaterThan(0);
      expect(depth).toBeLessThan(MAP_DEPTH);
    }
  });

  /*
   * The hull groans past test depth and the enemy hears it, so a boat berthed below its own
   * limit starts the match broadcasting — before its owner has given an order, and without
   * having chosen to. Asserted per boat against its *resolved* stats, because a pressure hull
   * moves the limit.
   */
  describe('never berths a boat below its test depth', () => {
    for (const [label, map] of [
      ['open water', EMPTY],
      ['a carved map', DENSE],
    ] as const) {
      it(`on ${label}`, () => {
        const state = deploy(map, [
          player('host', 'team1', [LIGHT, HEAVY, LIGHT, HEAVY]),
          player('guest', 'team2', [HEAVY, LIGHT, HEAVY, LIGHT]),
        ]);

        expect(state.boats).toHaveLength(8);
        for (const boat of state.boats) {
          expect(depthAt(map.extents, boat.pos.y)).toBeLessThanOrEqual(boat.stats.testDepth);
        }
      });
    }

    it('on every map size, where the same Y is a different depth', () => {
      for (const size of MAP_SIZES) {
        const map = generateMap('dense', { seed: 3, mapSize: size });
        const state = deploy(map);

        for (const boat of state.boats) {
          expect(depthAt(map.extents, boat.pos.y)).toBeLessThanOrEqual(boat.stats.testDepth);
        }
      }
    });

    it('gives a boat with a deep-rated hull the deeper berth it paid for', () => {
      const plain: BoatTemplate = { name: 'S-01', hull: 'medium', modules: [] };
      const reinforced: BoatTemplate = {
        ...plain,
        modules: [{ slot: 'equipment', index: 0, module: 'titanium-hull' }],
      };

      // Identical fleets but for the module, so the ordinals — and therefore the depth
      // slices they aim at — are the same in both. What differs is only what they may take.
      const shallow = deploy(EMPTY, [player('host', 'team1', [plain, plain])]);
      const deep = deploy(EMPTY, [player('host', 'team1', [reinforced, reinforced])]);
      const deepest = (boats: typeof shallow.boats) =>
        Math.max(...boats.map((boat) => depthAt(EMPTY.extents, boat.pos.y)));

      expect(deep.boats[0]?.stats.testDepth).toBeGreaterThan(
        shallow.boats[0]?.stats.testDepth ?? 0,
      );
      expect(deepest(deep.boats)).toBeGreaterThan(deepest(shallow.boats));
    });
  });

  it('is deterministic — same lobby, same map, same berths', () => {
    const first = deploy(DENSE);
    const second = deploy(DENSE);

    expect(second.boats.map((b) => [b.id, b.pos.x, b.pos.y])).toEqual(
      first.boats.map((b) => [b.id, b.pos.x, b.pos.y]),
    );
  });

  it('seats spectators without giving them boats', () => {
    const state = deploy(EMPTY, [
      player('host', 'team1', [LIGHT]),
      player('watcher', 'spectator', [LIGHT]),
    ]);

    expect(state.players.find((p) => p.accountId === 'watcher')?.team).toBeNull();
    expect(boatsOwnedBy(state, 'watcher')).toEqual([]);
    expect(state.boats).toHaveLength(1);
  });

  it('opens both standings at zero, counting the fleets that are actually there', () => {
    const state = deploy(EMPTY, [
      player('host', 'team1', [LIGHT, HEAVY]),
      player('guest', 'team2', [LIGHT]),
    ]);

    expect(state.teams.team1.boatsTotal).toBe(2);
    expect(state.teams.team2.boatsTotal).toBe(1);
    expect(state.teams.team1.boatsAlive).toBe(2);
    expect(state.teams.team1.score).toBe(0);
    expect(state.teams.team1.survivingPoints).toBeGreaterThan(state.teams.team2.survivingPoints);
    expect(state.clock).toEqual({ tick: 0, elapsedSeconds: 0, remainingSeconds: 30 * 60 });
  });

  it('keeps each player’s boats in the order they were built', () => {
    const state = deploy(EMPTY, [player('host', 'team1', [LIGHT, HEAVY, LIGHT])]);

    expect(boatsOwnedBy(state, 'host').map((boat) => boat.index)).toEqual([0, 1, 2]);
    expect(boatsOnTeam(state, 'team1')).toHaveLength(3);
  });

  it('places three capture zones in water, mirror-symmetric about mid-map', () => {
    const state = deploy(DENSE);
    const ruler = new TerrainRuler(DENSE.extents, DENSE.terrain.obstacles);

    expect(state.zones).toHaveLength(3);
    for (const zone of state.zones) {
      expect(ruler.clearanceAt(zone.centre.x, zone.centre.y)).toBeGreaterThan(0);
      expect(zone.holder).toBeNull();
      expect(zone.progress).toBe(0);
    }
    // Ids are distinct and outside the boats' range, so a log never confuses the two.
    const ids = state.zones.map((zone) => zone.id);
    expect(new Set(ids).size).toBe(3);
    expect(Math.min(...ids)).toBeGreaterThan(Math.max(...state.boats.map((b) => b.id)));
  });

  it('fields no capture zones in deathmatch', () => {
    const state = deployMatch({
      matchId: 'm1',
      mode: 'deathmatch',
      map: EMPTY,
      startedAt: 0,
      players: [player('host', 'team1', [LIGHT])],
    });

    expect(state.zones).toEqual([]);
  });
});
