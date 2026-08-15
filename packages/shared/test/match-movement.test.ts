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
  mirrorFacing,
  MOVEMENT_ACCELERATION,
  reversesToward,
  stepBoat,
  throttleSpeedFor,
  WRECK_SINK_SPEED,
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
    weaponSubstitutions: {},
    moduleModifiers: [],
    pos: { x: 0, y: 0 },
    facing: 0,
    speed: 0,
    throttle: 'slow',
    hp: STATS.maxHp,
    tubes: [],
    order: HOLDING,
    status: 'active',
    activeSonar: false,
    lastPingTick: 0,
    transients: [],
    ...overrides,
  };
}

function transitTo(x: number, y: number): BoatState['order'] {
  return { kind: 'transit', waypoints: [{ x, y }] };
}

describe('stepBoat', () => {
  it('leaves a holding boat exactly as it is', () => {
    const held = boat();
    expect(stepBoat(held, 0.05)).toBe(held);
  });

  it('sinks a destroyed boat instead of running its order', () => {
    // A wreck ignores its old order entirely — it has no throttle, no turning, and nothing left
    // to steer toward. Only `pos.y` moves, straight down.
    const wreck = boat({ status: 'destroyed', order: transitTo(100, 0), facing: 45, speed: 8 });
    const sunk = stepBoat(wreck, 0.05);

    expect(sunk.pos).toEqual({ x: 0, y: -WRECK_SINK_SPEED * 0.05 });
    expect(sunk.facing).toBe(wreck.facing);
    expect(sunk.order).toBe(wreck.order);
  });

  it('stops sinking once a wreck has sunk out of the map, rather than falling forever', () => {
    const gone = boat({ status: 'destroyed', pos: { x: 0, y: -5 } });
    expect(stepBoat(gone, 0.05)).toBe(gone);
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
    // 250 m abeam. A Medium at flank turns on a 178 m circle, so a point abeam is unreachable
    // inside 356 m — this corner is well inside that and cannot be bent onto at any point of the
    // approach. (It has to be measured against the hull's own turn rate; when those got faster,
    // a corner 500 m abeam stopped being an example of this case and became one of the next test.)
    const corner = { x: 0, y: 250 };
    const onward = { x: 2000, y: 250 };
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

  it('reverses for an intermediate waypoint too, rather than writing it off', () => {
    // A doubling-back leg is not the turning-circle case the made-good skip exists for: the
    // boat can reach it now, so it brakes for it instead of dropping it.
    const behind = { x: -300, y: 0 };
    const onward = { x: -2000, y: 0 };
    const flank = throttleSpeedFor(STATS, 'flank');
    const moving = abeamAtFlank([behind, onward]);

    const first = stepBoat(moving, 0.05);
    expect(first.order).toEqual({ kind: 'transit', waypoints: [behind, onward] });
    expect(first.speed).toBeLessThan(flank);
  });

  it('still runs an intermediate waypoint it can make, rather than skipping it', () => {
    // At the slow notch the turning circle is about 33 m — easily inside a 500 m corner.
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

describe('mirrorFacing', () => {
  it('reflects about the vertical: same pitch, other side', () => {
    expect(mirrorFacing(0)).toBe(180);
    expect(mirrorFacing(180)).toBe(0);
    // Ten degrees of nose-up travelling right is ten degrees of nose-up travelling left.
    expect(mirrorFacing(10)).toBe(170);
    expect(mirrorFacing(170)).toBe(10);
    // And a down angle stays a down angle: −10° mirrors to 190°, not to 10°.
    expect(mirrorFacing(350)).toBe(190);
  });

  it('is its own inverse', () => {
    for (const facing of [0, 17, 95, 183, 271, 359])
      expect(mirrorFacing(mirrorFacing(facing))).toBeCloseTo(facing, 9);
  });
});

describe('reversesToward', () => {
  it('reverses for a bearing abaft the beam and on the other side', () => {
    expect(reversesToward(0, 180)).toBe(true);
    expect(reversesToward(0, 170)).toBe(true);
    expect(reversesToward(0, 190)).toBe(true);
    expect(reversesToward(170, 10)).toBe(true);
  });

  it('turns for anything forward of the beam', () => {
    expect(reversesToward(0, 89)).toBe(false);
    expect(reversesToward(0, 90)).toBe(false);
    expect(reversesToward(0, -90)).toBe(false);
    // Steeply nose-up and the point is across the vertical: the other side, but a few degrees
    // of turn away. Mirroring would be the long way round.
    expect(reversesToward(80, 100)).toBe(false);
  });

  it('turns for a point astern on its own side, which mirroring would not reach', () => {
    // Nose up and to the right; the point is down and to the right, 95° abaft the beam. The
    // mirror of that bearing is off to port — the wrong ocean entirely.
    expect(reversesToward(35, 300)).toBe(false);
  });
});

describe('stepBoat reversing direction', () => {
  const FLANK = throttleSpeedFor(STATS, 'flank');

  /** Which horizontal band the boat is in. The bit a reversal exists to change. */
  function rightward(facing: number): boolean {
    return Math.cos((facing * Math.PI) / 180) >= 0;
  }

  /** Steps until the boat has changed bands, returning it and how long that took. */
  function reverse(from: BoatState): { readonly boat: BoatState; readonly seconds: number } {
    let moving = from;
    let seconds = 0;
    while (rightward(moving.facing) === rightward(from.facing) && seconds < 300) {
      moving = stepBoat(moving, 0.05);
      seconds += 0.05;
    }
    return { boat: moving, seconds };
  }

  it('flips a stopped boat where it stands', () => {
    const stopped = boat({ order: transitTo(-100, 0) });
    const flipped = stepBoat(stopped, 0.05);

    expect(flipped.facing).toBeCloseTo(180, 9);
    expect(flipped.speed).toBe(0);
    expect(flipped.pos).toEqual({ x: 0, y: 0 });
  });

  it('brakes to a stop and mirrors, never rotating through the vertical', () => {
    const ordered = boat({ throttle: 'flank', speed: FLANK, order: transitTo(-1000, 0) });

    let moving = ordered;
    let seconds = 0;
    while (seconds < 300) {
      const before = moving;
      moving = stepBoat(moving, 0.05);
      seconds += 0.05;
      if (!rightward(moving.facing)) break;
      // Slowing, not swinging: the bow is still dead ahead and the way is coming off.
      expect(moving.speed).toBeLessThan(before.speed);
      expect(moving.facing).toBeCloseTo(0, 9);
      // And still making way while it does — a reversal is not a free brake.
      expect(moving.pos.x).toBeGreaterThan(before.pos.x);
    }

    expect(moving.speed).toBe(0);
    expect(moving.facing).toBeCloseTo(180, 9);
  });

  it('reverses in the time it takes to stop, not the time it takes to turn', () => {
    const { seconds } = reverse(
      boat({ throttle: 'flank', speed: FLANK, order: transitTo(-1000, 0) }),
    );

    // The whole cost is the brake, to within the tick it completes on.
    const braking = FLANK / MOVEMENT_ACCELERATION;
    expect(seconds).toBeGreaterThanOrEqual(braking);
    expect(seconds).toBeLessThanOrEqual(braking + 0.05);
    // Which is the point: turning through the vertical is a different order of magnitude.
    expect(seconds).toBeLessThan(180 / STATS.turnRate);
  });

  it('lines the pitch up on the mirror, so the flip lands on the bearing', () => {
    // 1000 m astern and 176 m up — a bearing of 170°, whose mirror is 10°. The boat pitches
    // toward 10° while the way comes off, so it mirrors onto something short of a bare 180°.
    const { boat: flipped } = reverse(
      boat({ throttle: 'flank', speed: FLANK, order: transitTo(-1000, 176) }),
    );

    expect(flipped.facing).toBeLessThan(180);
    expect(flipped.facing).toBeGreaterThan(170);
  });

  it('comes about and runs the leg it reversed for', () => {
    let moving = boat({ throttle: 'flank', speed: FLANK, order: transitTo(-500, 0) });
    for (let i = 0; i < 4000 && moving.order.kind === 'transit'; i += 1)
      moving = stepBoat(moving, 0.05);

    expect(moving.order).toEqual(HOLDING);
    expect(moving.pos).toEqual({ x: -500, y: 0 });
  });

  it('turns, and keeps its speed, for a waypoint forward of the beam', () => {
    // 80° off the bow. Well round, but no reversal: the boat leans into it under way.
    let moving = boat({ throttle: 'flank', speed: FLANK, order: transitTo(174, 985) });
    for (let i = 0; i < 20; i += 1) moving = stepBoat(moving, 0.05);

    expect(moving.facing).toBeGreaterThan(0);
    expect(moving.facing).toBeCloseTo(STATS.turnRate * 1, 5);
    expect(moving.speed).toBeCloseTo(FLANK);
  });

  it('turns for a point astern on its own side rather than mirroring away from it', () => {
    // Nose 35° up, the point 60° down and to the same side. The boat noses over toward it.
    let moving = boat({ facing: 35, order: transitTo(500, -866) });
    for (let i = 0; i < 20; i += 1) moving = stepBoat(moving, 0.05);

    expect(moving.facing).toBeLessThan(35);
    expect(moving.facing).toBeCloseTo(35 - STATS.turnRate * 1, 5);
    expect(moving.speed).toBeGreaterThan(0);
  });
});
