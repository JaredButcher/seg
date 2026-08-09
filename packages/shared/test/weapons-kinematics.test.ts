/**
 * How a weapon moves, and the pitch band that decides what it can chase.
 *
 * The counterpart of `match-movement` one weapon down: `stepTorpedo` is pure and knows nothing
 * about the map, the fleet, or the fuze, so this pins the ballistics and `weapons-phase` can be
 * about the tick.
 *
 * The load that carries most of these is the **super-cavitating** one, because its numbers are
 * the ones designed to be a weakness: ±12° of pitch and 10 °/s of turn are what stop it chasing
 * anything, and a change that quietly widened either would delete the reason the standard
 * torpedo exists.
 */

import {
  bearingDeg,
  clampPitch,
  getWeapon,
  hasArrived,
  stepTorpedo,
  TORPEDO_ACCELERATION,
  turningRadius,
  turnToward,
  type TorpedoState,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

function torpedo(overrides: Partial<TorpedoState> = {}): TorpedoState {
  return {
    id: 10,
    weapon: 'standard',
    team: 'team1',
    owner: 'a1',
    firedBy: 1,
    firedTick: 0,
    aim: { x: 1000, y: 0 },
    mimic: null,
    pos: { x: 0, y: 0 },
    facing: 0,
    speed: getWeapon('standard').speed,
    travelled: 0,
    phase: 'running',
    track: null,
    trackTick: 0,
    lastPingTick: 0,
    transients: [],
    ...overrides,
  };
}

describe('clampPitch', () => {
  it('leaves a heading inside either band exactly where it is', () => {
    expect(clampPitch(30, 40)).toBe(30);
    expect(clampPitch(330, 40)).toBe(330);
    // The left-travelling band, around 180°.
    expect(clampPitch(150, 40)).toBe(150);
    expect(clampPitch(210, 40)).toBe(210);
  });

  it('pulls a steeper heading back to the nearest edge of the nearer band', () => {
    // Straight up is 50° outside a ±40° band on the right and 50° outside it on the left; the
    // arithmetic picks the right-hand edge, which is the side the weapon is already travelling.
    expect(clampPitch(60, 40)).toBe(40);
    expect(clampPitch(300, 40)).toBe(320);
    expect(clampPitch(120, 40)).toBe(140);
    expect(clampPitch(240, 40)).toBe(220);
  });

  it('is far tighter for a super-cavitating weapon, which is the point of it', () => {
    const { maxPitch } = getWeapon('super-cavitating');
    expect(maxPitch).toBe(12);
    // Asked to climb at 45°, it will demand 12° and no more.
    expect(clampPitch(45, maxPitch)).toBe(12);
  });
});

describe('turningRadius', () => {
  it('is small enough for a standard torpedo to genuinely chase', () => {
    expect(turningRadius('standard')).toBeCloseTo(50.4, 0);
  });

  it('is most of a super-cavitating weapon’s useful range', () => {
    // 315 m against a 1200 m range: it cannot be talked out of the line it left the tube on,
    // which is its designed weakness in the horizontal.
    expect(turningRadius('super-cavitating')).toBeCloseTo(315, 0);
  });
});

describe('stepTorpedo', () => {
  it('accelerates to its cruising speed and no further', () => {
    const slow = torpedo({ speed: 6 });
    expect(stepTorpedo(slow, null, 0.05).speed).toBeCloseTo(6 + TORPEDO_ACCELERATION * 0.05, 6);

    const fast = torpedo({ speed: getWeapon('standard').speed });
    expect(stepTorpedo(fast, null, 0.05).speed).toBe(getWeapon('standard').speed);
  });

  it('holds its course when there is nothing to steer at', () => {
    // What an unguided weapon does past its aim point, and what a homing one does between
    // contacts. It keeps moving; it simply stops turning.
    const held = stepTorpedo(torpedo({ facing: 30 }), null, 0.05);
    expect(held.facing).toBe(30);
    expect(held.pos.x).toBeGreaterThan(0);
    expect(held.pos.y).toBeGreaterThan(0);
  });

  it('counts the water it has covered, which is the other half of expiry', () => {
    const moved = stepTorpedo(torpedo(), null, 0.05);
    expect(moved.travelled).toBeCloseTo(getWeapon('standard').speed * 0.05, 6);
  });

  it('turns at the weapon’s own rate rather than snapping onto a bearing', () => {
    const turning = stepTorpedo(torpedo({ facing: 0 }), { x: 0, y: 1000 }, 0.05);
    // 25 °/s for a tenth of the way there, not 90° in one tick.
    expect(turning.facing).toBeCloseTo(getWeapon('standard').turnRate * 0.05, 6);
  });

  it('will not point a super-cavitating weapon at something above its pitch band', () => {
    // A target 45° up. The weapon demands 12° and settles there, however long it is given —
    // which is exactly how a target that dives hard escapes one.
    let weapon = torpedo({ weapon: 'super-cavitating', speed: 55, facing: 0 });
    for (let i = 0; i < 200; i += 1) weapon = stepTorpedo(weapon, { x: 1000, y: 1000 }, 0.05);
    expect(weapon.facing).toBeCloseTo(12, 3);
  });

  it('lets a standard torpedo reach a much steeper angle, because its band is wider', () => {
    let weapon = torpedo({ facing: 0 });
    for (let i = 0; i < 200; i += 1) weapon = stepTorpedo(weapon, { x: 1000, y: 1000 }, 0.05);
    expect(weapon.facing).toBeCloseTo(40, 3);
  });
});

describe('hasArrived', () => {
  it('counts a point inside the turning circle as reached', () => {
    // The geometry `match/movement.ts` documents: a point closer than `v/ω` can never be
    // touched however long the weapon orbits. A boat gives up speed for it; a torpedo cannot,
    // so it settles for being that close — and without this a standard torpedo that slightly
    // overshot its enable point would circle it forever instead of switching its seeker on.
    const weapon = torpedo({ pos: { x: 0, y: 0 } });
    expect(hasArrived(weapon, { x: 40, y: 0 }, 1.1)).toBe(true);
    expect(hasArrived(weapon, { x: 200, y: 0 }, 1.1)).toBe(false);
  });

  it('is at least one tick of travel wide, so nothing is skipped between ticks', () => {
    const weapon = torpedo({ weapon: 'super-cavitating', speed: 55 });
    // A step wider than the turning circle would otherwise let the aim point fall between ticks.
    expect(hasArrived(weapon, { x: 400, y: 0 }, 500)).toBe(true);
  });
});

describe('bearingDeg and turnToward', () => {
  it('take the short way round rather than the long one', () => {
    expect(bearingDeg({ x: 0, y: 0 }, { x: 0, y: -10 })).toBe(270);
    // From 350° to 10° is twenty degrees forward, not three hundred and forty back.
    expect(turnToward(350, 10, 25, 1)).toBeCloseTo(10, 6);
    expect(turnToward(350, 10, 5, 1)).toBeCloseTo(355, 6);
  });
});
