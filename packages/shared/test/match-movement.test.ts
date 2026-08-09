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
  maxApproachSpeed,
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

describe('maxApproachSpeed', () => {
  it('does not constrain a point dead ahead or dead astern', () => {
    expect(maxApproachSpeed(50, 0, STATS.turnRate)).toBe(Infinity);
    expect(maxApproachSpeed(50, 180, STATS.turnRate)).toBe(Infinity);
  });

  it('is the speed whose turning circle passes exactly through the point', () => {
    // Abeam: the point is on the circle when distance = 2r, i.e. r = distance/2.
    const omega = (STATS.turnRate * Math.PI) / 180;
    expect(maxApproachSpeed(500, 90, STATS.turnRate)).toBeCloseTo(omega * 250);

    // Symmetric about the bow, and tighter the further off-bearing the point is.
    expect(maxApproachSpeed(500, -90, STATS.turnRate)).toBe(
      maxApproachSpeed(500, 90, STATS.turnRate),
    );
    expect(maxApproachSpeed(500, 30, STATS.turnRate)).toBeGreaterThan(
      maxApproachSpeed(500, 90, STATS.turnRate),
    );
  });
});

describe('stepBoat approaching a waypoint it would overshoot', () => {
  /** Flank down the +x axis with the waypoint abeam: 500 m at a 505 m turning circle. */
  function abeamAtFlank(waypoints: readonly { x: number; y: number }[]): BoatState {
    return boat({
      throttle: 'flank',
      speed: throttleSpeedFor(STATS, 'flank'),
      order: { kind: 'transit', waypoints },
    });
  }

  it('slows for the last waypoint rather than orbiting it', () => {
    let moving = abeamAtFlank([{ x: 0, y: 500 }]);
    let slowest = Infinity;
    for (let i = 0; i < 4000 && moving.order.kind === 'transit'; i += 1) {
      moving = stepBoat(moving, 0.05);
      slowest = Math.min(slowest, moving.speed);
    }

    // It arrives — the point of the exercise — and it gave up speed to do it.
    expect(moving.order).toEqual(HOLDING);
    expect(moving.pos).toEqual({ x: 0, y: 500 });
    expect(slowest).toBeLessThan(throttleSpeedFor(STATS, 'flank'));
  });

  it('never lets the last waypoint inside its turning circle on the way in', () => {
    // Ordered abeam at flank, the boat is already over the cap on tick one, so the invariant is
    // "at or under the cap, or braking toward it as hard as the hull allows".
    let moving = abeamAtFlank([{ x: 0, y: 500 }]);
    for (let i = 0; i < 4000 && moving.order.kind === 'transit'; i += 1) {
      const before = moving;
      const distance = Math.hypot(0 - before.pos.x, 500 - before.pos.y);
      const bearing = (Math.atan2(500 - before.pos.y, 0 - before.pos.x) * 180) / Math.PI;
      const offBearing = ((bearing - before.facing + 540) % 360) - 180;
      const cap = maxApproachSpeed(distance, offBearing, STATS.turnRate);
      const braking = before.speed - MOVEMENT_ACCELERATION * 0.05;

      moving = stepBoat(moving, 0.05);
      if (moving.order.kind !== 'transit') break;

      expect(moving.speed).toBeLessThanOrEqual(Math.max(cap, braking) + 1e-9);
    }
  });

  it('counts an intermediate waypoint as made good instead of slowing for it', () => {
    const corner = { x: 0, y: 500 };
    const onward = { x: 2000, y: 500 };
    let moving = abeamAtFlank([corner, onward]);

    const first = stepBoat(moving, 0.05);
    // The corner is inside the turning circle from the off, so it goes on the first tick —
    // and the boat keeps its speed up for the leg beyond it.
    expect(first.order).toEqual({ kind: 'transit', waypoints: [onward] });
    expect(first.speed).toBeCloseTo(throttleSpeedFor(STATS, 'flank'));

    for (let i = 0; i < 4000 && moving.order.kind === 'transit'; i += 1)
      moving = stepBoat(moving, 0.05);
    expect(moving.pos).toEqual(onward);
  });

  it('still runs an intermediate waypoint it can make, rather than skipping it', () => {
    // Same corner, but at the slow notch the turning circle is ~87 m — easily inside 500 m.
    let moving = boat({
      order: {
        kind: 'transit',
        waypoints: [
          { x: 0, y: 500 },
          { x: 0, y: 900 },
        ],
      },
    });
    let reached: BoatState | undefined;
    for (let i = 0; i < 20_000 && reached === undefined; i += 1) {
      moving = stepBoat(moving, 0.05);
      if (moving.order.kind === 'transit' && moving.order.waypoints.length === 1) reached = moving;
    }

    expect(reached?.pos).toEqual({ x: 0, y: 500 });
  });
});
