/**
 * The movement phase in pure form: one boat, one tick.
 *
 * `MatchRuntime` applies `stepBoat` to every boat on every tick; these tests pin down what a
 * single step does, so the runtime test can lean on them for the orchestration (order, cancel,
 * queue) and stay about pictures. Movement itself lives here.
 */

import {
  getHull,
  HOLDING,
  MOVEMENT_ACCELERATION,
  stepBoat,
  throttleSpeedFor,
  type BoatState,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

const STATS = getHull('medium').stats;

function boat(overrides: Partial<BoatState> = {}): BoatState {
  return {
    id: 1,
    team: 'team1',
    owner: 'a1',
    index: 0,
    name: 'S-01',
    hull: 'medium',
    stats: STATS,
    cost: 120,
    pos: { x: 0, y: 0 },
    facing: 0,
    speed: 0,
    throttle: 'slow',
    hp: STATS.maxHp,
    tubes: [],
    order: HOLDING,
    status: 'active',
    ...overrides,
  };
}

function transitTo(x: number, y: number): BoatState['order'] {
  return { kind: 'transit', waypoints: [{ x, y }] };
}

describe('stepBoat', () => {
  it('leaves a holding boat exactly as it is, and a destroyed one too', () => {
    const held = boat();
    expect(stepBoat(held, 0.05)).toBe(held);

    const wreck = boat({ status: 'destroyed', order: transitTo(100, 0) });
    expect(stepBoat(wreck, 0.05)).toBe(wreck);
  });

  it('returns a boat with no waypoints to a stop and to hold', () => {
    const orderless = boat({ order: { kind: 'transit', waypoints: [] }, speed: 3 });
    const stopped = stepBoat(orderless, 0.05);
    expect(stopped.speed).toBe(0);
    expect(stopped.order).toEqual(HOLDING);
  });

  it('accelerates toward the throttle notch’s speed', () => {
    const ordered = boat({ order: transitTo(1000, 0) });
    const afterOne = stepBoat(ordered, 0.05);
    expect(afterOne.speed).toBeCloseTo(MOVEMENT_ACCELERATION * 0.05);

    // A long run settles on the slow notch's absolute speed, not some fraction of max.
    let moving = ordered;
    for (let i = 0; i < 200; i += 1) moving = stepBoat(moving, 0.05);
    expect(moving.speed).toBeCloseTo(throttleSpeedFor(STATS, 'slow'));
  });

  it('drives straight into a waypoint dead ahead and arrives holding', () => {
    let moving = boat({ order: transitTo(3, 0) });
    for (let i = 0; i < 200; i += 1) moving = stepBoat(moving, 0.05);

    expect(moving.order).toEqual(HOLDING);
    expect(moving.speed).toBe(0);
    expect(moving.pos).toEqual({ x: 3, y: 0 });
  });

  it('turns toward an off-axis waypoint, limited by the turn rate', () => {
    // Waypoint is 90° to port; the boat must swing around at turnRate, not snap about.
    let moving = boat({ order: transitTo(0, 100) });
    for (let i = 0; i < 20; i += 1) moving = stepBoat(moving, 0.05);

    const turned = STATS.turnRate * 1; // one second of turning
    expect(moving.facing).toBeGreaterThan(0);
    expect(moving.facing).toBeLessThan(90);
    expect(moving.facing).toBeCloseTo(turned, 5);
  });

  it('pops waypoints in order, moving on to the next leg when one is reached', () => {
    let moving = boat({
      order: {
        kind: 'transit',
        waypoints: [
          { x: 3, y: 0 },
          { x: 0, y: 3 },
        ],
      },
    });
    let dropped: BoatState | undefined;
    for (let i = 0; i < 1000 && dropped === undefined; i += 1) {
      moving = stepBoat(moving, 0.05);
      if (moving.order.kind === 'transit' && moving.order.waypoints.length === 1) dropped = moving;
    }

    expect(dropped).toBeDefined();
    expect(dropped?.order).toEqual({ kind: 'transit', waypoints: [{ x: 0, y: 3 }] });
  });
});
