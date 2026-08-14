/**
 * Which weapon in the water is a problem, and whose.
 *
 * The module behind the line on the scope and the alert on the fleet row, so what is being pinned
 * here is mostly *restraint*: an alert that fires for every torpedo on the map is an alert players
 * learn to ignore, and the interesting tests are the ones where a weapon is close, or pointed
 * roughly this way, and is still correctly not flagged.
 *
 * Geometry is laid out along `+x` throughout — the weapon at the origin running east, targets out
 * in front of it — so the numbers in each test are read as "how far ahead" and "how far off to one
 * side" rather than having to be trigonometry.
 */

import { getHull, getWeapon, type Stats } from '@seg/shared';
import { describe, expect, it } from 'vitest';

import {
  THREAT_HORIZON_SECONDS,
  THREAT_UNKNOWN_RADIUS_M,
  threatOf,
  threatenedIds,
  threatsAmong,
  type ThreatTarget,
  type ThreatWeapon,
} from '../src/render/threat.js';

const MEDIUM: Stats = getHull('medium').stats;
/** Half of it, which is what the solver adds to every radius. A Medium is 140 m of boat. */
const HALF_HULL = getHull('medium').length / 2;

/** A weapon at the origin running east, of whatever load. `null` is an unidentified contact. */
function weapon(overrides: Partial<ThreatWeapon> = {}): ThreatWeapon {
  return {
    key: 'w1',
    pos: { x: 0, y: 0 },
    facing: 0,
    weapon: 'active-torpedo',
    speed: null,
    ...overrides,
  };
}

/** A boat sitting `ahead` metres east and `off` metres to one side, stopped unless told otherwise. */
function boat(ahead: number, off = 0, overrides: Partial<ThreatTarget> = {}): ThreatTarget {
  return {
    id: 1,
    pos: { x: ahead, y: off },
    facing: 0,
    speed: 0,
    hull: 'medium',
    stats: MEDIUM,
    depth: 300,
    ...overrides,
  };
}

describe('closing', () => {
  it('flags a weapon running straight at a boat', () => {
    const threat = threatOf(weapon(), [boat(600)]);

    expect(threat?.target).toBe(1);
    expect(threat?.cpa).toBeCloseTo(0, 6);
    // 600 m at the load's 22 m/s. The solver takes the speed off the table, because a contact
    // never carries one.
    expect(threat?.seconds).toBeCloseTo(600 / getWeapon('active-torpedo').speed, 3);
  });

  it('says nothing about a weapon going the other way', () => {
    // Already past, opening the range. Somebody else's problem now.
    expect(threatOf(weapon(), [boat(-400)])).toBeNull();
  });

  it('says nothing about a weapon running parallel, however close it is', () => {
    // Alongside at 60 m and matching course and speed: alarming to look at, and the range is not
    // changing, so there is nothing to warn about that the mark itself does not already say.
    const alongside = weapon({ weapon: 'super-cavitating', speed: 14 });
    expect(threatOf(alongside, [boat(0, 60, { speed: 14 })])).toBeNull();
  });

  it('says nothing about a weapon that will not arrive inside the horizon', () => {
    const far = 22 * (THREAT_HORIZON_SECONDS + 20);
    expect(threatOf(weapon(), [boat(far)])).toBeNull();

    // The same weapon, the same bearing, close enough to matter.
    expect(threatOf(weapon(), [boat(22 * (THREAT_HORIZON_SECONDS - 5))])).not.toBeNull();
  });

  it('counts a boat driving into a weapon’s path, not only a weapon driving at a boat', () => {
    // The weapon is pointed away up the y axis and could not care less; the boat is crossing its
    // line. Closing is a property of the pair, which is why it is one dot product over the
    // relative velocity rather than a test on the weapon's heading.
    const crossing = weapon({ weapon: 'super-cavitating', facing: 90 });
    const driver = boat(0, 500, { facing: -90, speed: 14 });

    expect(threatOf(crossing, [driver])).not.toBeNull();
  });
});

describe('how close is close enough', () => {
  it('flags a super-cavitating weapon only on a line that actually hits', () => {
    const scv = weapon({ weapon: 'super-cavitating' });
    const burst = getWeapon('super-cavitating').damageRadius;

    // Inside the burst plus half a hull: it connects.
    expect(threatOf(scv, [boat(600, HALF_HULL + burst - 10)])).not.toBeNull();
    // Outside it. The weapon has a 315 m turning circle and no sonar at all — it is going exactly
    // where it was pointed, and where it was pointed is past you.
    expect(threatOf(scv, [boat(600, HALF_HULL + burst + 40)])).toBeNull();
  });

  it('flags a homing weapon far wider than it could ever hit, because it will turn', () => {
    // The same miss distance that makes a super-cavitating round harmless makes a homing one a
    // problem: it is inside the seeker's reach, ahead of the nose, and the seeker steers.
    const wide = HALF_HULL + getWeapon('active-torpedo').damageRadius + 120;

    expect(threatOf(weapon({ weapon: 'super-cavitating' }), [boat(500, wide)])).toBeNull();
    expect(threatOf(weapon({ weapon: 'active-torpedo' }), [boat(500, wide)])).not.toBeNull();
  });

  it('will not let a seeker hear round the back of itself', () => {
    // `SEEKER_ARC` is 60° either side of the nose and a seeker is deaf outside it
    // (`sim/weapons/seeker.ts`). A boat well abeam is inside the acquisition *range* and still
    // cannot be acquired, so only the physical burst test applies — and that misses.
    const abeam = threatOf(weapon(), [boat(20, 260, { speed: 6, facing: 180 })]);
    expect(abeam).toBeNull();

    // The identical geometry rotated in front of the nose is a threat.
    expect(threatOf(weapon(), [boat(260, 20, { speed: 6, facing: 180 })])).not.toBeNull();
  });
});

describe('a passive weapon’s reach is the target’s problem', () => {
  /*
   * All three tests share one piece of geometry — a boat sitting 400 m ahead of the weapon and
   * 350 m off to the side — so that the only thing that ever varies is what the weapon is and what
   * the boat is doing. At depth 300 a Medium radiates enough to be heard by a passive seeker from
   * 205 m stopped and 1164 m once it is past its cavitation speed, against an active seeker's flat
   * 346 m; 350 m sits between the first and the last, which is what makes the comparison possible
   * at all.
   */
  const AHEAD = 400;
  const OFF = 350;

  it('is defeated by the same boat holding still, where an active one is not', () => {
    // The whole of the pair's trade, in one geometry. Same place, same boat, same range: the echo
    // finds him because it does not care what he is doing, and the ear does not because he is not
    // doing anything.
    const quiet = boat(AHEAD, OFF, { speed: 0 });

    expect(threatOf(weapon({ weapon: 'active-torpedo' }), [quiet])).not.toBeNull();
    expect(threatOf(weapon({ weapon: 'passive-torpedo' }), [quiet])).toBeNull();
  });

  it('finds him the moment he opens the throttle', () => {
    // Past the cavitation speed his reach against a passive seeker goes from 205 m to over a
    // kilometre, and the alert that was not there is. The screw is the tell, exactly as the
    // acoustic model has always said — this is the first surface that says it out loud.
    const running = boat(AHEAD, OFF, { speed: 9, facing: 90 });

    expect(threatOf(weapon({ weapon: 'passive-torpedo' }), [running])).not.toBeNull();
  });

  it('gets the alert back if he slows down again', () => {
    // Not a state machine: it is recomputed from the pose every frame, so the warning follows the
    // throttle in both directions rather than latching on the first fright.
    const passive = weapon({ weapon: 'passive-torpedo' });

    expect(threatOf(passive, [boat(AHEAD, OFF, { speed: 9, facing: 90 })])).not.toBeNull();
    expect(threatOf(passive, [boat(AHEAD, OFF, { speed: 0, facing: 90 })])).toBeNull();
  });
});

describe('an unidentified contact', () => {
  it('is assumed able to home, because assuming otherwise hides the warning', () => {
    // Below `identificationThreshold` the team knows a weapon is in the water and nothing else.
    // A guess that it is harmless would suppress the alert in exactly the case with least
    // information behind it.
    const unknown = weapon({ weapon: null });

    expect(threatOf(unknown, [boat(600, THREAT_UNKNOWN_RADIUS_M - 50)])).not.toBeNull();
    expect(threatOf(unknown, [boat(600, HALF_HULL + THREAT_UNKNOWN_RADIUS_M + 100)])).toBeNull();
  });

  it('can have its alert removed by being identified', () => {
    // A super-cavitating round is a far narrower threat than the generic assumption. Learning
    // which load it is should be able to make the problem smaller, and here it does.
    const at = boat(500, HALF_HULL + THREAT_UNKNOWN_RADIUS_M - 60);

    expect(threatOf(weapon({ weapon: null }), [at])).not.toBeNull();
    expect(threatOf(weapon({ weapon: 'super-cavitating' }), [at])).toBeNull();
  });
});

describe('picking the target', () => {
  it('takes the smallest closest approach rather than the nearest boat right now', () => {
    // The distinction the whole CPA arithmetic exists for. Boat 1 is much nearer but well off to
    // the side and will only get further away; boat 2 is further off and dead ahead.
    const scv = weapon({ weapon: 'super-cavitating' });
    const near = boat(60, 200, { id: 1 });
    const ahead = boat(900, 0, { id: 2 });

    expect(threatOf(scv, [near, ahead])?.target).toBe(2);
  });

  it('reports at most one target per weapon, and hands back both poses for the line', () => {
    const threat = threatOf(weapon(), [boat(600), boat(700, 40, { id: 2 })]);

    expect(threat?.from).toEqual({ x: 0, y: 0 });
    expect(threat?.to).toEqual({ x: 600, y: 0 });
  });

  it('solves a whole water of weapons, and reduces to the set a fleet row needs', () => {
    const closing = weapon({ key: 'a' });
    const leaving = weapon({ key: 'b', pos: { x: 900, y: 0 } });

    const threats = threatsAmong([closing, leaving], [boat(600)]);
    expect(threats.map((threat) => threat.weapon)).toEqual(['a']);
    expect([...threatenedIds(threats)]).toEqual([1]);
  });

  it('is empty when there is nothing in the water, or nothing to hit', () => {
    expect(threatsAmong([], [boat(600)])).toEqual([]);
    expect(threatsAmong([weapon()], [])).toEqual([]);
    expect([...threatenedIds([])]).toEqual([]);
  });
});
