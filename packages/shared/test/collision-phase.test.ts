/**
 * The collision phase — what the runtime does with a step that ended somewhere illegal.
 *
 * The phase takes the fleet before movement and the fleet after it, so these tests hand it both
 * halves directly rather than simulating a ride into a wall. That is the honest way to test a rule:
 * `collision-shapes` proves the geometry, `match-movement` proves the ride, and this proves what
 * happens when the two disagree.
 */

import {
  ACOUSTICS,
  getHull,
  GRAZE_SPEED,
  HOLDING,
  resolveCollisions,
  SIM_TICK_HZ,
  TerrainCollider,
  transientLevel,
  type BoatState,
  type MapExtents,
  type Obstacle,
  type Vec2,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

const EXTENTS: MapExtents = { width: 1000, height: 1000 };
const TICK = 40;

/** A wall filling the map's height from x = 200 rightward. */
const WALL: Obstacle = {
  vertices: [
    { x: 200, y: 0 },
    { x: 1000, y: 0 },
    { x: 1000, y: 1000 },
    { x: 200, y: 1000 },
  ],
};

const TERRAIN = new TerrainCollider(EXTENTS, [WALL]);

function boat(overrides: Partial<BoatState> = {}): BoatState {
  const hull = getHull(overrides.hull ?? 'medium');
  return {
    id: 1,
    team: 'team1',
    owner: 'a1',
    index: 0,
    name: 'S-01',
    hull: hull.id,
    stats: hull.stats,
    cost: hull.cost,
    pos: { x: 100, y: 500 },
    facing: 0,
    speed: 0,
    throttle: 'flank',
    hp: hull.stats.maxHp,
    tubes: [],
    order: HOLDING,
    status: 'active',
    activeSonar: false,
    lastPingTick: 0,
    transients: [],
    ...overrides,
  };
}

/** The same boat one tick later, moved and under way. */
function moved(from: BoatState, pos: Vec2, speed: number): BoatState {
  return { ...from, pos, speed, order: { kind: 'transit', waypoints: [{ x: 900, y: 500 }] } };
}

function settle(
  before: readonly BoatState[],
  after: readonly BoatState[],
  terrain: TerrainCollider | null = TERRAIN,
): readonly BoatState[] {
  return resolveCollisions({ before, after, terrain, tick: TICK, tickHz: SIM_TICK_HZ });
}

describe('a boat driven into rock', () => {
  // At x = 150 a Medium's bow is 20 m inside the wall; at x = 100 the whole boat is clear.
  const before = boat({ speed: 8, order: { kind: 'transit', waypoints: [{ x: 900, y: 500 }] } });
  const after = moved(before, { x: 150, y: 500 }, 8);

  it('is put back where it came from, stopped, and stripped of its orders', () => {
    const [stopped] = settle([before], [after]);

    expect(stopped?.pos).toEqual({ x: 100, y: 500 });
    expect(stopped?.speed).toBe(0);
    // The order goes with it: a boat that kept its route would drive back into the wall on the very
    // next tick and go on doing it, one +30 dB bang a second, for the rest of the match.
    expect(stopped?.order).toEqual(HOLDING);
  });

  it('takes no damage from it — that is Q39, and it is not built', () => {
    const [stopped] = settle([before], [after]);
    expect(stopped?.hp).toBe(before.hp);
    expect(stopped?.status).toBe('active');
  });

  it('is heard across the map, as bottom contact', () => {
    const [stopped] = settle([before], [after]);

    expect(stopped?.transients).toEqual([{ kind: 'bottoming', tick: TICK }]);
    // And it is the loudest thing in the transient table, which is what makes a careless transit
    // expensive rather than merely annoying (planning/03 §3).
    expect(transientLevel('bottoming', 0)).toBeGreaterThan(ACOUSTICS.cavitationPenalty);
  });

  it('keeps the heading it hit at, because turning is how it gets out', () => {
    const turned = { ...after, facing: 30 };
    const [stopped] = settle([before], [turned]);
    expect(stopped?.facing).toBe(30);
  });

  it('is silent when it was only feeling its way along, past Q39’s grazing threshold', () => {
    const creeping = { ...before, speed: GRAZE_SPEED - 0.5 };
    const [stopped] = settle([creeping], [moved(creeping, { x: 150, y: 500 }, GRAZE_SPEED - 0.5)]);

    // Still refused — a hull cannot be inside stone at any speed — but not an event.
    expect(stopped?.pos).toEqual({ x: 100, y: 500 });
    expect(stopped?.transients).toEqual([]);
  });

  it('may move freely if it was already in the rock, rather than being stuck for the match', () => {
    const inside = boat({ pos: { x: 300, y: 500 }, speed: 6 });
    const deeper = moved(inside, { x: 320, y: 500 }, 6);
    const [escaping] = settle([inside], [deeper]);

    expect(escaping).toBe(deeper);
  });

  it('is left alone on a map with no terrain at all', () => {
    const fleet = [moved(before, { x: 150, y: 500 }, 8)];
    expect(settle([before], fleet, null)).toBe(fleet);
  });

  it('costs nothing on a tick where nothing touched anything', () => {
    const fleet = [moved(before, { x: 110, y: 500 }, 8)];
    // Referentially unchanged, so a quiet tick allocates nothing downstream either.
    expect(settle([before], fleet)).toBe(fleet);
  });

  it('does not fire again on the tick after, now that it is stopped and holding', () => {
    const [stopped] = settle([before], [after]);
    if (stopped === undefined) throw new Error('no boat');
    const fleet = [stopped];
    expect(settle(fleet, fleet)).toBe(fleet);
  });
});

describe('two boats that met', () => {
  const a = boat({ id: 1, pos: { x: 500, y: 500 }, facing: 0, speed: 5 });
  const b = boat({ id: 2, pos: { x: 800, y: 500 }, facing: 180, speed: 5 });
  // 60 m apart bow to bow: two 140 m hulls, so 80 m of overlap.
  const closed: readonly BoatState[] = [
    { ...a, pos: { x: 500, y: 500 } },
    { ...b, pos: { x: 560, y: 500 } },
  ];

  it('both stop where they were, and both lose their orders', () => {
    const settled = settle([a, b], closed, null);

    expect(settled[0]?.pos).toEqual({ x: 500, y: 500 });
    expect(settled[1]?.pos).toEqual({ x: 800, y: 500 });
    expect(settled[0]?.speed).toBe(0);
    expect(settled[1]?.order).toEqual(HOLDING);
  });

  it('both take the same minor damage, scaled by how hard they closed', () => {
    const settled = settle([a, b], closed, null);
    const hurt = getHull('medium').stats.maxHp - (settled[0]?.hp ?? 0);

    expect(hurt).toBeGreaterThan(0);
    expect(settled[1]?.hp).toBeCloseTo(settled[0]?.hp ?? 0);
    // Minor: nowhere near the `DAMAGED_HP_FRACTION` cliff off a single 10 m/s bump.
    expect(hurt).toBeLessThan(getHull('medium').stats.maxHp / 4);
  });

  it('both make the collision transient, which is not the same event as taking a hit', () => {
    const settled = settle([a, b], closed, null);

    expect(settled[0]?.transients).toEqual([{ kind: 'collision', tick: TICK }]);
    expect(settled[1]?.transients).toEqual([{ kind: 'collision', tick: TICK }]);
    // A listener that could classify it must not be told "hull damage" — that would read as
    // somebody having scored a hit on them.
    expect(transientLevel('collision', 0)).not.toBe(transientLevel('hull-damage', 0));
  });

  it('a nudge is harmless and silent, and still refused', () => {
    const drifting: readonly BoatState[] = [
      { ...a, speed: 0.4 },
      { ...b, speed: 0.4 },
    ];
    const bumped: readonly BoatState[] = [
      { ...drifting[0], pos: { x: 500, y: 500 } } as BoatState,
      { ...drifting[1], pos: { x: 560, y: 500 } } as BoatState,
    ];
    const settled = settle(drifting, bumped, null);

    expect(settled[0]?.hp).toBe(a.hp);
    expect(settled[0]?.transients).toEqual([]);
    expect(settled[0]?.speed).toBe(0);
  });

  it('a boat rammed with nothing left is destroyed', () => {
    const dying: readonly BoatState[] = [
      { ...a, hp: 1, speed: 14 },
      { ...b, speed: 14 },
    ];
    const impact: readonly BoatState[] = [
      { ...dying[0], pos: { x: 500, y: 500 } } as BoatState,
      { ...dying[1], pos: { x: 560, y: 500 } } as BoatState,
    ];
    const settled = settle(dying, impact, null);

    expect(settled[0]?.hp).toBe(0);
    expect(settled[0]?.status).toBe('destroyed');
    // The other one is merely hurt. Nothing here doubles the damage for the boat that did the
    // ramming, and nothing halves it either: a collision is symmetric.
    expect(settled[1]?.status).toBe('active');
  });

  it('takes both impacts when a boat is caught between two others', () => {
    // A stopped boat with one closing on each end, and the two of them far enough apart not to
    // reach each other — so the boat in the middle is the only one in two collisions.
    const middle = boat({ id: 1, pos: { x: 500, y: 500 }, facing: 0, speed: 0 });
    const ahead = boat({ id: 2, pos: { x: 900, y: 500 }, facing: 180, speed: 5 });
    const astern = boat({ id: 3, pos: { x: 100, y: 500 }, facing: 0, speed: 5 });
    const squeezed: readonly BoatState[] = [
      middle,
      { ...ahead, pos: { x: 580, y: 500 } },
      { ...astern, pos: { x: 420, y: 500 } },
    ];
    const settled = settle([middle, ahead, astern], squeezed, null);

    const maxHp = getHull('medium').stats.maxHp;
    const both = maxHp - (settled[0]?.hp ?? 0);
    expect(both).toBeCloseTo(maxHp - (settled[1]?.hp ?? 0) + (maxHp - (settled[2]?.hp ?? 0)));
    expect(both).toBeGreaterThan(0);
  });

  it('leaves two boats already overlapping free to move apart', () => {
    const overlapping: readonly BoatState[] = [
      { ...a, pos: { x: 500, y: 500 } },
      { ...b, pos: { x: 560, y: 500 } },
    ];
    const separating: readonly BoatState[] = [
      { ...a, pos: { x: 490, y: 500 } },
      { ...b, pos: { x: 570, y: 500 } },
    ];
    expect(settle(overlapping, separating, null)).toBe(separating);
  });

  it('ignores a wreck', () => {
    const wreck = { ...b, status: 'destroyed' as const };
    const into: readonly BoatState[] = [
      { ...a, pos: { x: 500, y: 500 } },
      { ...wreck, pos: { x: 560, y: 500 } },
    ];
    expect(settle([a, wreck], into, null)).toBe(into);
  });
});
