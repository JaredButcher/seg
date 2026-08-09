/**
 * The weapons phase: arming, seeking, fuzing, and the bang.
 *
 * `weapons-kinematics` pins the ballistics; this is about the tick — what order things happen
 * in, what a warhead catches, and the two rules that are easy to get subtly wrong and impossible
 * to notice from a screenshot: that **rock is cover** (a weapon that would have reached a hull
 * through a wall hits the wall), and that **friendly fire is real** (a burst does not ask whose
 * hull it is looking at).
 *
 * Run without terrain unless a test is about terrain, because the map is not what is being
 * tested and a generated cave would put a wall wherever it liked.
 */

import {
  detonationDamage,
  FUZE_ARM_SECONDS,
  getHull,
  getWeapon,
  HOLDING,
  launch,
  newTube,
  reloadSecondsFor,
  SEEKER_HOLD_SECONDS,
  stepWeapons,
  TORPEDO_PROXIMITY_FUZE,
  type BoatState,
  type TorpedoState,
  type WeaponsOutcome,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

const TICK_HZ = 20;
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
    tubes: [newTube(0, 'standard'), newTube(1, 'super-cavitating')],
    order: HOLDING,
    status: 'active',
    activeSonar: false,
    lastPingTick: 0,
    transients: [],
    ...overrides,
  };
}

function torpedo(overrides: Partial<TorpedoState> = {}): TorpedoState {
  return {
    id: 100,
    weapon: 'standard',
    team: 'team1',
    owner: 'a1',
    firedBy: 1,
    firedTick: 0,
    aim: { x: 1000, y: 0 },
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

/** One tick, with no map. `tick` is the sim tick the phase is being asked to advance to. */
function step(
  boats: readonly BoatState[],
  torpedoes: readonly TorpedoState[],
  tick = 100,
): WeaponsOutcome {
  return stepWeapons({ boats, torpedoes, terrain: null, tick, tickHz: TICK_HZ });
}

/**
 * Advance a scenario `ticks` times, threading the fleet and the weapons through.
 *
 * `detonations` **accumulates** rather than reporting the last tick's, unlike `stepWeapons`
 * itself. A detonation is a one-tick event and a spent weapon leaves a few seconds later, so a
 * run long enough to be interesting is a run that has already forgotten the bang it was about.
 */
function run(
  boats: readonly BoatState[],
  torpedoes: readonly TorpedoState[],
  ticks: number,
  from = 100,
): WeaponsOutcome {
  let outcome: WeaponsOutcome = { boats, torpedoes, detonations: [], damaged: false };
  const detonations: WeaponsOutcome['detonations'][number][] = [];

  for (let i = 0; i < ticks; i += 1) {
    outcome = stepWeapons({
      boats: outcome.boats,
      torpedoes: outcome.torpedoes,
      terrain: null,
      tick: from + i,
      tickHz: TICK_HZ,
    });
    detonations.push(...outcome.detonations);
  }
  return { ...outcome, detonations };
}

describe('launching', () => {
  it('puts the weapon ahead of the bow, on the boat’s heading, and sounds the tube', () => {
    const firing = boat({ pos: { x: 500, y: 500 }, facing: 0 });
    const { boat: after, torpedo: weapon } = launch({
      boat: firing,
      tubeIndex: 0,
      id: 42,
      aim: { x: 1500, y: 500 },
      tick: 40,
      tickHz: TICK_HZ,
    });

    // Clear of a hull that is 140 m long, so the fuze cannot find home during its arming delay.
    expect(weapon.pos.x).toBeGreaterThan(500 + getHull('medium').length / 2);
    expect(weapon.pos.y).toBe(500);
    // The boat's heading, not the bearing to the aim point: a tube points where the boat points,
    // which is why turning to face a target before firing is worth doing.
    expect(weapon.facing).toBe(0);
    expect(weapon.phase).toBe('running');

    expect(after.tubes[0]?.status).toBe('reloading');
    expect(after.tubes[0]?.readyInSeconds).toBe(reloadSecondsFor(STATS));
    expect(after.transients).toContainEqual({ kind: 'torpedo-launch', tick: 40 });
  });

  it('makes a four-tube salvo exactly one bang', () => {
    // Power-summing four copies of one launch would put 6 dB on the map that nothing produced,
    // and a boat that could be quieter by staggering its shots would have a mechanic nobody
    // designed. `withTransient`'s same-kind-same-tick rule is what enforces it.
    let firing = boat({ tubes: [newTube(0, 'standard'), newTube(1, 'standard')] });
    for (const index of [0, 1]) {
      firing = launch({
        boat: firing,
        tubeIndex: index,
        id: 50 + index,
        aim: { x: 900, y: 0 },
        tick: 40,
        tickHz: TICK_HZ,
      }).boat;
    }

    expect(firing.transients).toHaveLength(1);
    expect(firing.tubes.every((tube) => tube.status === 'reloading')).toBe(true);
  });
});

describe('the run-out', () => {
  it('arms at the aim point, and a weapon with no seeker simply keeps going', () => {
    // Both loads reach `enabled` — it is a fact about geometry, not about the seeker — and what
    // they do about it is the load's business (`match/torpedo.ts`).
    const scv = torpedo({
      weapon: 'super-cavitating',
      speed: 55,
      pos: { x: 990, y: 0 },
      aim: { x: 1000, y: 0 },
    });
    const after = step([], [scv]);
    expect(after.torpedoes[0]?.phase).toBe('enabled');
    // Still steering while it was `running`, so this tick's turn is toward the aim point — but
    // dead ahead, so it does not turn at all. What matters is that it keeps going and that the
    // arrival did not divert it.
    expect(after.torpedoes[0]?.facing).toBe(0);
    expect(after.torpedoes[0]?.pos.x).toBeGreaterThan(990);
    expect(after.torpedoes[0]?.speed).toBe(55);
  });

  it('holds its heading once enabled, however far it drifts from the aim point', () => {
    // The super-cavitating weapon's whole behaviour after arrival: nothing. It keeps the line it
    // left the tube on until it hits something or its clock runs out.
    const past = torpedo({
      weapon: 'super-cavitating',
      speed: 55,
      phase: 'enabled',
      facing: 0,
      pos: { x: 1200, y: 0 },
      // Well off to one side. A weapon that still steered would turn hard toward it.
      aim: { x: 1000, y: 900 },
    });
    const after = run([], [past], 40);
    expect(after.torpedoes[0]?.facing).toBe(0);
    expect(after.torpedoes[0]?.pos.y).toBe(0);
  });

  it('steps every tube on every boat, even with nothing in the water', () => {
    const reloading = boat({
      tubes: [{ ...newTube(0, 'standard'), status: 'reloading', readyInSeconds: 1 }],
    });
    const after = step([reloading], []);
    expect(after.torpedoes).toHaveLength(0);
    expect(after.boats[0]?.tubes[0]?.readyInSeconds).toBeCloseTo(0.95, 6);
  });

  it('hands back the same arrays when nothing at all is happening', () => {
    // Most ticks in a match. A quiet tick must allocate nothing — the same bargain
    // `resolveCollisions` makes with its identity return.
    const idle = [boat()];
    const after = step(idle, []);
    expect(after.boats).toBe(idle);
    expect(after.damaged).toBe(false);
  });
});

describe('expiry', () => {
  it('detonates on its own clock rather than fizzling out', () => {
    // A warhead that has run out of fuel is still a warhead, it is loud, and one that expires
    // beside your own boat is your own fault.
    const old = torpedo({ firedTick: 0 });
    const lifetime = getWeapon('standard').lifetimeSeconds;
    const after = step([], [old], Math.ceil(lifetime * TICK_HZ));

    expect(after.detonations).toHaveLength(1);
    expect(after.torpedoes[0]?.phase).toBe('spent');
    expect(after.torpedoes[0]?.transients[0]?.kind).toBe('torpedo-detonation');
  });

  it('detonates on fuel too, at the range in the table', () => {
    const spentFuel = torpedo({ travelled: getWeapon('standard').range });
    expect(step([], [spentFuel]).detonations).toHaveLength(1);
  });

  it('keeps the wreck in the world until the bang has rung down, then drops it', () => {
    // Removing it at the moment of impact would delete the loudest event in the game from the
    // ocean it happened in.
    const spent = torpedo({
      phase: 'spent',
      speed: 0,
      transients: [{ kind: 'torpedo-detonation', tick: 100 }],
    });

    expect(step([], [spent], 120).torpedoes).toHaveLength(1);
    // Four seconds of ringing at 20 Hz.
    expect(step([], [spent], 100 + 4 * TICK_HZ).torpedoes).toHaveLength(0);
  });
});

describe('the fuze', () => {
  it('is not live for the first moments, so a weapon cannot find the boat that fired it', () => {
    const target = boat({ id: 2, pos: { x: 30, y: 0 } });
    const fresh = torpedo({ firedTick: 100, pos: { x: 30, y: 0 } });

    expect(step([target], [fresh], 100).detonations).toHaveLength(0);
    const armed = step([target], [fresh], 100 + Math.ceil(FUZE_ARM_SECONDS * TICK_HZ) + 1);
    expect(armed.detonations).toHaveLength(1);
  });

  it('fires on proximity to the hull, not to the hull’s centre', () => {
    // A submarine is mostly length. Measuring to the centre would let a warhead sit against a
    // Heavy's bow eighty-five metres from "the boat", which is a direct hit that does nothing.
    const long = getHull('medium').length;
    const target = boat({ id: 2, pos: { x: 0, y: 0 }, facing: 0 });
    // Just off the bow, well outside the proximity radius measured from the centre.
    const nose = torpedo({
      firedTick: 0,
      speed: 0,
      pos: { x: long / 2 + TORPEDO_PROXIMITY_FUZE / 2, y: 0 },
    });

    expect(step([target], [nose]).detonations).toHaveLength(1);
  });

  it('ignores a wreck, so a kill does not become a decoy for the next weapon through', () => {
    const wreck = boat({ id: 2, status: 'destroyed', hp: 0 });
    const passing = torpedo({ firedTick: 0, speed: 0, pos: { x: 0, y: 0 } });
    expect(step([wreck], [passing]).detonations).toHaveLength(0);
  });
});

describe('the burst', () => {
  it('falls off linearly and reaches nothing at the damage radius', () => {
    const { damage, damageRadius } = getWeapon('standard');
    expect(detonationDamage('standard', 0)).toBe(damage);
    expect(detonationDamage('standard', damageRadius / 2)).toBeCloseTo(damage / 2, 6);
    expect(detonationDamage('standard', damageRadius)).toBe(0);
    expect(detonationDamage('standard', damageRadius + 1)).toBe(0);
  });

  it('damages every hull it catches, both teams and the firer included', () => {
    // Friendly fire is on (Q7), and it is on in the phase rather than in a check the caller
    // could forget — the burst never asks whose hull it is looking at.
    const mine = boat({ id: 1, team: 'team1', pos: { x: 0, y: 0 } });
    const theirs = boat({ id: 2, team: 'team2', pos: { x: 30, y: 0 } });
    const weapon = torpedo({ firedTick: 0, firedBy: 1, speed: 0, pos: { x: 15, y: 0 } });

    const after = step([mine, theirs], [weapon]);
    expect(after.damaged).toBe(true);
    expect(after.detonations[0]?.hits.map((hit) => hit.boat).sort()).toEqual([1, 2]);
    expect(after.boats[0]?.hp).toBeLessThan(STATS.maxHp);
    expect(after.boats[1]?.hp).toBeLessThan(STATS.maxHp);
  });

  it('sounds the hull’s own damage on top of the weapon’s bang', () => {
    // Two events, and a listener close enough hears both: the bang belongs to the weapon and the
    // groan belongs to the hull.
    const target = boat({ id: 2, pos: { x: 0, y: 0 } });
    const weapon = torpedo({ firedTick: 0, speed: 0, pos: { x: 0, y: 0 } });

    const after = step([target], [weapon], 200);
    expect(after.boats[0]?.transients).toContainEqual({ kind: 'hull-damage', tick: 200 });
    expect(after.torpedoes[0]?.transients).toContainEqual({
      kind: 'torpedo-detonation',
      tick: 200,
    });
  });

  it('destroys a boat that runs out of hit points, and there is no repair', () => {
    const dying = boat({ id: 2, hp: 5, pos: { x: 0, y: 0 } });
    const weapon = torpedo({ firedTick: 0, speed: 0, pos: { x: 0, y: 0 } });

    const after = step([dying], [weapon]);
    expect(after.boats[0]?.hp).toBe(0);
    expect(after.boats[0]?.status).toBe('destroyed');
  });
});

describe('the seeker', () => {
  it('stays asleep during the run-out, however close the target is', () => {
    // The enable point is the decision. A weapon that hunted on the way out would make where the
    // player clicked mean nothing.
    const target = boat({ id: 2, team: 'team2', pos: { x: 200, y: 0 }, speed: 8 });
    const running = torpedo({ firedTick: 0, phase: 'running', aim: { x: 3000, y: 0 } });

    const after = step([target], [running]);
    expect(after.torpedoes[0]?.lastPingTick).toBe(0);
    expect(after.torpedoes[0]?.track).toBeNull();
  });

  it('pulses once armed, and acquires a hull inside its range', () => {
    const target = boat({ id: 2, team: 'team2', pos: { x: 200, y: 0 } });
    const armed = torpedo({ firedTick: 0, phase: 'enabled', pos: { x: 0, y: 0 } });

    const after = step([target], [armed]);
    expect(after.torpedoes[0]?.lastPingTick).toBe(100);
    expect(after.torpedoes[0]?.track).toEqual({ x: 200, y: 0 });
    expect(after.torpedoes[0]?.trackTick).toBe(100);
  });

  it('is deaf beyond a few hundred metres, which is what makes the enable point matter', () => {
    // 95 dB of pulse against 20 dB of its own machinery, paying the path twice. A generous
    // seeker would make the aim point decoration.
    const far = boat({ id: 2, team: 'team2', pos: { x: 800, y: 0 } });
    const armed = torpedo({ firedTick: 0, phase: 'enabled' });

    const after = step([far], [armed]);
    expect(after.torpedoes[0]?.lastPingTick).toBe(100);
    expect(after.torpedoes[0]?.track).toBeNull();
  });

  it('cannot see behind itself', () => {
    const astern = boat({ id: 2, team: 'team2', pos: { x: -200, y: 0 } });
    const armed = torpedo({ firedTick: 0, phase: 'enabled', facing: 0 });
    expect(step([astern], [armed]).torpedoes[0]?.track).toBeNull();
  });

  it('will chase a teammate, because it has no idea whose hull it is', () => {
    // planning/04 §7 wants this failure to be possible and memorable, so the seeker does not
    // filter by team — a weapon that could not be walked into a friend would be a weapon with a
    // rule the acoustic model does not have.
    const friend = boat({ id: 2, team: 'team1', pos: { x: 200, y: 0 } });
    const armed = torpedo({ team: 'team1', firedTick: 0, phase: 'enabled' });
    expect(step([friend], [armed]).torpedoes[0]?.track).toEqual({ x: 200, y: 0 });
  });

  it('holds a stale track briefly, then gives up and runs straight on', () => {
    // A target that slips between two pulses has not gone anywhere in a second, and a weapon
    // that straightened out instantly would be defeated by an aspect change. But a torpedo
    // committed to a stale position is one the player can watch sail past.
    const stale = torpedo({
      firedTick: 0,
      phase: 'enabled',
      facing: 0,
      track: { x: 0, y: 400 },
      trackTick: 100,
      // Already pinged, so this tick is not a pulse and the track cannot be refreshed.
      lastPingTick: 100,
    });

    const held = step([], [stale], 100 + SEEKER_HOLD_SECONDS * TICK_HZ - 1);
    expect(held.torpedoes[0]?.facing).toBeGreaterThan(0);

    const dropped = step([], [{ ...stale, facing: 0 }], 100 + SEEKER_HOLD_SECONDS * TICK_HZ + 1);
    expect(dropped.torpedoes[0]?.facing).toBe(0);
  });

  it('steers a homing weapon onto a target and eventually kills it', () => {
    // The whole mechanic end to end: enable point ahead of the target, seeker wakes, weapon
    // turns onto what it hears, fuze fires.
    const target = boat({ id: 2, team: 'team2', pos: { x: 250, y: 60 } });
    const weapon = torpedo({ firedTick: 0, phase: 'enabled', pos: { x: 0, y: 0 }, facing: 0 });

    const after = run([target], [weapon], 400);
    expect(after.detonations).toHaveLength(1);
    expect(after.detonations[0]?.hits.map((hit) => hit.boat)).toEqual([2]);
    expect(after.boats[0]?.hp).toBeLessThan(STATS.maxHp);
  });

  it('never wakes up on a super-cavitating weapon, whatever it is next to', () => {
    const target = boat({ id: 2, team: 'team2', pos: { x: 150, y: 0 } });
    const scv = torpedo({ weapon: 'super-cavitating', speed: 55, phase: 'enabled', firedTick: 0 });
    // The fuze may catch the boat; the seeker must not have looked for it.
    expect(step([target], [scv]).torpedoes[0]?.lastPingTick).toBe(0);
  });
});
