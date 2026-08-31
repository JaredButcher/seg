/**
 * How a weapon moves, and the turning circle that decides what it can chase.
 *
 * The counterpart of `match-movement` one weapon down: `stepTorpedo` is pure and knows nothing
 * about the map, the fleet, or the fuze, so this pins the ballistics and `weapons-phase` can be
 * about the tick.
 *
 * The load that carries most of these is the **super-cavitating** one, because its numbers are
 * the ones designed to be a weakness: a 315 m turning circle against a 1200 m range and 10 °/s of
 * turn are what stop it chasing anything, and a change that quietly widened either would delete
 * the reason the homing torpedoes exist. Since the pitch band was removed that circle is the
 * *only* thing separating the two loads' ability to follow a target, so these are the numbers
 * that now carry the whole of the design.
 */

import {
  bearingDeg,
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
    weapon: 'active-torpedo',
    team: 'team1',
    owner: 'a1',
    firedBy: 1,
    firedTick: 0,
    aim: { x: 1000, y: 0 },
    mimic: null,
    pos: { x: 0, y: 0 },
    facing: 0,
    speed: getWeapon('active-torpedo').speed,
    travelled: 0,
    phase: 'running',
    track: null,
    trackTick: 0,
    lastPingTick: 0,
    transients: [],
    ...overrides,
  };
}

describe('turningRadius', () => {
  it('is small enough for a homing torpedo to genuinely chase', () => {
    expect(turningRadius('active-torpedo')).toBeCloseTo(50.4, 0);
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

    const fast = torpedo({ speed: getWeapon('active-torpedo').speed });
    expect(stepTorpedo(fast, null, 0.05).speed).toBe(getWeapon('active-torpedo').speed);
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
    expect(moved.travelled).toBeCloseTo(getWeapon('active-torpedo').speed * 0.05, 6);
  });

  it('turns at the weapon’s own rate rather than snapping onto a bearing', () => {
    const turning = stepTorpedo(torpedo({ facing: 0 }), { x: 0, y: 1000 }, 0.05);
    // 25 °/s for a tenth of the way there, not 90° in one tick.
    expect(turning.facing).toBeCloseTo(getWeapon('active-torpedo').turnRate * 0.05, 6);
  });

  /*
   * The three below steer at points a thousand kilometres off, which is not a distance any map
   * has. It is so that the *bearing* holds still while the weapon turns onto it: a weapon aimed
   * at something nearby swings the demand round as it closes, and what is being pinned here is
   * the heading it is allowed to hold, not the pursuit.
   */

  it('holds any pitch it is steered at, however steep', () => {
    // The mechanic that was removed. Every load used to settle at the edge of a ±40° cruise
    // band, so a 45° climb was flown at 40° and a target that simply swam upward was safe.
    // Nothing clamps now: the weapon holds the bearing it was given, whichever load it is.
    for (const id of ['active-torpedo', 'super-cavitating'] as const) {
      let weapon = torpedo({ weapon: id, speed: getWeapon(id).speed, facing: 0 });
      for (let i = 0; i < 400; i += 1) weapon = stepTorpedo(weapon, { x: 1e9, y: 1e9 }, 0.05);
      expect(weapon.facing).toBeCloseTo(45, 3);
    }
  });

  it('climbs straight up, which is the heading the band could never produce', () => {
    // Dead vertical sat exactly between the old two wedges, so the demand snapped to one edge or
    // the other and jumped sides as the weapon drifted past. It is now just a bearing.
    let weapon = torpedo({ facing: 0 });
    for (let i = 0; i < 200; i += 1) weapon = stepTorpedo(weapon, { x: 0, y: 1e9 }, 0.05);
    expect(weapon.facing).toBeCloseTo(90, 3);
  });

  it('turns through the vertical onto a bearing astern rather than mirroring', () => {
    // Weapons used to brake to a stop and reflect `facing` about the vertical to reach anything
    // behind them, because the pitch band left no way to rotate there. It is one turn at
    // `turnRate` now, and the tell is that the weapon never gives up a metre per second to make
    // it — the flip was paid for entirely in speed.
    let weapon = torpedo({ facing: 0, pos: { x: 0, y: 0 } });
    for (let i = 0; i < 200; i += 1) {
      weapon = stepTorpedo(weapon, { x: -1e9, y: 0 }, 0.05);
      expect(weapon.speed).toBe(getWeapon('active-torpedo').speed);
    }
    expect(weapon.facing).toBeCloseTo(180, 3);
    // And it left the line it was launched on, sweeping its own turning circle to get round,
    // which a mirrored flip never did.
    expect(Math.abs(weapon.pos.y)).toBeGreaterThan(turningRadius('active-torpedo'));
  });
});

describe('hasArrived', () => {
  it('counts a point inside the turning circle as reached', () => {
    // The geometry `match/movement.ts` documents: a point closer than `v/ω` can never be
    // touched however long the weapon orbits. A boat gives up speed for it; a torpedo cannot,
    // so it settles for being that close — and without this a homing torpedo that slightly
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
