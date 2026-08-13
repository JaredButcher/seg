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
  bearingDeg,
  DEPLOYABLE_WEAPON_IDS,
  detonationDamage,
  FUZE_ARM_SECONDS,
  getHull,
  getWeapon,
  headingDelta,
  HOLDING,
  launch,
  LAUNCH_SPEED,
  newTube,
  reloadSecondsFor,
  SEEKER_HOLD_SECONDS,
  stepWeapons,
  TORPEDO_LAUNCH_ALIGNMENT,
  TORPEDO_LAUNCH_SETTLE_SECONDS,
  TORPEDO_LAUNCH_SPEED,
  TORPEDO_PROXIMITY_FUZE,
  type BoatState,
  type TorpedoState,
  type WeaponsOutcome,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

const TICK_HZ = 20;
const STATS = getHull('medium').stats;

/**
 * A map for the phase to read depths out of, and nothing else.
 *
 * Only the passive seeker looks at it — it asks how loud its candidates are, and cavitation
 * depends on depth (`sim/weapons/phase.ts#WeaponsPhase`). Everything else in this file ignores it,
 * so it is one shape shared by every scenario rather than a per-test fixture. Boats sit at `y = 0`
 * here, which `depthAt` reads as the *deepest* water on the map — quiet, and therefore the
 * conservative end for a test about whether something is heard at all.
 */
const EXTENTS = { width: 4000, height: 2000 };

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
    tubes: [newTube(0, 'active-torpedo'), newTube(1, 'super-cavitating')],
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
    alignedTick: 0,
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
  return stepWeapons({ boats, torpedoes, terrain: null, extents: EXTENTS, tick, tickHz: TICK_HZ });
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
      extents: EXTENTS,
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
    // And getting round onto the bearing is the weapon's own problem, from a standing start.
    expect(weapon.phase).toBe('launch');
    expect(weapon.mimic).toBeNull();

    expect(after.tubes[0]?.status).toBe('reloading');
    expect(after.tubes[0]?.readyInSeconds).toBe(reloadSecondsFor(STATS));
    expect(after.transients).toContainEqual({ kind: 'torpedo-launch', tick: 40 });
  });

  it('makes a four-tube salvo exactly one bang', () => {
    // Power-summing four copies of one launch would put 6 dB on the map that nothing produced,
    // and a boat that could be quieter by staggering its shots would have a mechanic nobody
    // designed. `withTransient`'s same-kind-same-tick rule is what enforces it.
    let firing = boat({ tubes: [newTube(0, 'active-torpedo'), newTube(1, 'active-torpedo')] });
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
      tubes: [{ ...newTube(0, 'active-torpedo'), status: 'reloading', readyInSeconds: 1 }],
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
    const lifetime = getWeapon('active-torpedo').lifetimeSeconds;
    const after = step([], [old], Math.ceil(lifetime * TICK_HZ));

    expect(after.detonations).toHaveLength(1);
    expect(after.torpedoes[0]?.phase).toBe('spent');
    expect(after.torpedoes[0]?.transients[0]?.kind).toBe('torpedo-detonation');
  });

  it('detonates on fuel too, at the range in the table', () => {
    const spentFuel = torpedo({ travelled: getWeapon('active-torpedo').range });
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

  it('still detonates on a wreck, so a weapon that homed onto one can actually hit it', () => {
    // planning/04 §8 (revised): a wreck is a legitimate sonar contact and a legitimate seeker
    // target now, so the fuze has to be willing to close the loop — a torpedo that could home
    // onto a hulk but never go off on arrival would just fly through it forever.
    const wreck = boat({ id: 2, status: 'destroyed', hp: 0 });
    const passing = torpedo({ firedTick: 0, speed: 0, pos: { x: 0, y: 0 } });
    expect(step([wreck], [passing]).detonations).toHaveLength(1);
  });

  it('finds nothing to hit once the wreck has sunk out of the map', () => {
    const gone = boat({ id: 2, status: 'destroyed', hp: 0, pos: { x: 0, y: -5 } });
    const passing = torpedo({ firedTick: 0, speed: 0, pos: { x: 0, y: -5 } });
    expect(step([gone], [passing]).detonations).toHaveLength(0);
  });
});

describe('the burst', () => {
  it('falls off linearly and reaches nothing at the damage radius', () => {
    const { damage, damageRadius } = getWeapon('active-torpedo');
    expect(detonationDamage('active-torpedo', 0)).toBe(damage);
    expect(detonationDamage('active-torpedo', damageRadius / 2)).toBeCloseTo(damage / 2, 6);
    expect(detonationDamage('active-torpedo', damageRadius)).toBe(0);
    expect(detonationDamage('active-torpedo', damageRadius + 1)).toBe(0);
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

describe('the active seeker', () => {
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

/**
 * The passive seeker — the same weapon with the transducer switched off.
 *
 * Two things are being pinned here and they pull in opposite directions, which is the whole point
 * of the load existing (`content/weapons.ts`, "the homing pair"):
 *
 * 1. **It is silent**, in every place silence is observable — no pulse in the ocean, no ping
 *    alert, nothing on the debug overlay, `lastPingTick` never stamped.
 * 2. **Its reach is the target's problem, not its own.** One-way propagation off whatever the
 *    contact is radiating, so a boat under way is heard from far beyond anything the active
 *    seeker could reach, and a boat at all stop is heard from closer in than the active seeker
 *    would have found it.
 *
 * The distances below are chosen against the real numbers rather than guessed, and the margins
 * are wide enough that a tuning pass moves them together rather than flipping one:
 *
 * ```
 *              active seeker   passive, at rest   passive, at flank
 * Light            299 m            187 m               868 m
 * Medium           346 m            333 m              2266 m
 * ```
 */
describe('the passive seeker', () => {
  const LIGHT = getHull('light').stats;

  it('acquires without ever pinging, so nothing warns the target it is coming', () => {
    const target = boat({ id: 2, team: 'team2', pos: { x: 200, y: 0 } });
    const armed = torpedo({ weapon: 'passive-torpedo', firedTick: 0, phase: 'enabled' });

    const after = step([target], [armed]);
    expect(after.torpedoes[0]?.track).toEqual({ x: 200, y: 0 });
    expect(after.torpedoes[0]?.trackTick).toBe(100);
    // The one line that keeps it out of the transient channel, the ping alerts, and the overlay.
    expect(after.torpedoes[0]?.lastPingTick).toBe(0);
  });

  it('listens on every tick rather than on a transducer’s rhythm', () => {
    // The active load re-acquires once a second and a target that moves between pulses is chased
    // to a stale position. This one has no rhythm to be caught between, so a track taken on one
    // tick is refreshed on the very next.
    const target = boat({ id: 2, team: 'team2', pos: { x: 200, y: 0 } });
    const armed = torpedo({ weapon: 'passive-torpedo', firedTick: 0, phase: 'enabled' });

    const first = step([target], [armed], 100);
    expect(first.torpedoes[0]?.trackTick).toBe(100);

    const moved = boat({ id: 2, team: 'team2', pos: { x: 205, y: 0 } });
    const second = step([moved], [first.torpedoes[0]!], 101);
    expect(second.torpedoes[0]?.track).toEqual({ x: 205, y: 0 });
    expect(second.torpedoes[0]?.trackTick).toBe(101);
  });

  it('hears a boat under way from far outside anything the active seeker could reach', () => {
    // 800 m is more than twice the active seeker's 346 m against this hull, and comfortably
    // inside the 2266 m a Medium at flank radiates itself into.
    const running = boat({ id: 2, team: 'team2', pos: { x: 800, y: 0 }, speed: STATS.maxSpeed });

    const listening = torpedo({ weapon: 'passive-torpedo', firedTick: 0, phase: 'enabled' });
    expect(step([running], [listening]).torpedoes[0]?.track).toEqual({ x: 800, y: 0 });

    // The same geometry, the same target, the load that pings: nothing at all.
    const pinging = torpedo({ firedTick: 0, phase: 'enabled' });
    expect(step([running], [pinging]).torpedoes[0]?.track).toBeNull();
  });

  it('sails past a boat that has gone quiet, where the active seeker would have found him', () => {
    // The counter, and the reason this is not a strict upgrade. A Light at all stop is heard from
    // 187 m; the active seeker reads an echo off the same hull from 299 m, and does not care in
    // the least that he is holding still. 240 m sits between the two.
    const quiet = boat({
      id: 2,
      team: 'team2',
      hull: 'light',
      stats: LIGHT,
      pos: { x: 240, y: 0 },
      speed: 0,
    });

    const listening = torpedo({ weapon: 'passive-torpedo', firedTick: 0, phase: 'enabled' });
    expect(step([quiet], [listening]).torpedoes[0]?.track).toBeNull();

    const pinging = torpedo({ firedTick: 0, phase: 'enabled' });
    expect(step([quiet], [pinging]).torpedoes[0]?.track).toEqual({ x: 240, y: 0 });
  });

  it('hears the same boat once he opens the throttle, from the same place', () => {
    // The other half of the one above, so the pair reads as a *decision the target makes* rather
    // than as a fact about the Light hull. Same weapon, same range, same target — he moves.
    const at = { x: 240, y: 0 };
    const listening = torpedo({ weapon: 'passive-torpedo', firedTick: 0, phase: 'enabled' });
    const light = { id: 2, team: 'team2', hull: 'light', stats: LIGHT, pos: at } as const;

    expect(step([boat({ ...light, speed: 0 })], [listening]).torpedoes[0]?.track).toBeNull();
    expect(
      step([boat({ ...light, speed: LIGHT.maxSpeed })], [listening]).torpedoes[0]?.track,
    ).toEqual(at);
  });

  it('stays asleep during the run-out, however loud the target is', () => {
    // The enable point is the decision for this load exactly as it is for the active one. A
    // passive weapon that listened on the way out would be a weapon aimed at nothing.
    const loud = boat({ id: 2, team: 'team2', pos: { x: 200, y: 0 }, speed: STATS.maxSpeed });
    const running = torpedo({
      weapon: 'passive-torpedo',
      firedTick: 0,
      phase: 'running',
      aim: { x: 3000, y: 0 },
    });

    expect(step([loud], [running]).torpedoes[0]?.track).toBeNull();
  });

  it('cannot hear behind itself, the same arc the active seeker looks through', () => {
    const astern = boat({ id: 2, team: 'team2', pos: { x: -200, y: 0 }, speed: STATS.maxSpeed });
    const armed = torpedo({
      weapon: 'passive-torpedo',
      firedTick: 0,
      phase: 'enabled',
      facing: 0,
    });
    expect(step([astern], [armed]).torpedoes[0]?.track).toBeNull();
  });

  it('will chase a teammate, because it has no more idea whose noise it is', () => {
    const friend = boat({ id: 2, team: 'team1', pos: { x: 200, y: 0 } });
    const armed = torpedo({
      weapon: 'passive-torpedo',
      team: 'team1',
      firedTick: 0,
      phase: 'enabled',
    });
    expect(step([friend], [armed]).torpedoes[0]?.track).toEqual({ x: 200, y: 0 });
  });

  it('steers onto a running target and eventually kills it', () => {
    // End to end, and the mirror of the active seeker's kill test: enable point ahead of the
    // target, ears wake, weapon turns onto what it hears, fuze fires — with nothing ever emitted.
    const target = boat({ id: 2, team: 'team2', pos: { x: 250, y: 60 }, speed: STATS.maxSpeed });
    const weapon = torpedo({ weapon: 'passive-torpedo', firedTick: 0, phase: 'enabled' });

    const after = run([target], [weapon], 400);
    expect(after.detonations).toHaveLength(1);
    expect(after.detonations[0]?.hits.map((hit) => hit.boat)).toEqual([2]);
  });
});

describe('the launch phase', () => {
  it('creeps rather than winding up, so it can get round', () => {
    // The whole of the tax: a weapon still pointing where the boat was pointing does not get its
    // speed until it is pointing where it is going. The turning circle it buys is the reason.
    const off = torpedo({
      firedTick: 100,
      phase: 'launch',
      facing: 0,
      speed: LAUNCH_SPEED,
      aim: { x: 0, y: 900 },
    });

    const after = step([], [off], 101).torpedoes[0];
    expect(after?.phase).toBe('launch');
    expect(after?.speed).toBeLessThanOrEqual(TORPEDO_LAUNCH_SPEED);
    // Turning at its own rate meanwhile — the creep is a speed limit, not a hold.
    expect(after?.facing).toBeGreaterThan(0);
  });

  it('hands over the moment it is pointing where it is going, and then accelerates', () => {
    const off = torpedo({
      firedTick: 100,
      phase: 'launch',
      facing: 0,
      speed: LAUNCH_SPEED,
      aim: { x: 0, y: 900 },
    });

    // 90° at a homing torpedo's 25 °/s is under four seconds, plus the wind-up.
    const after = run([], [off], 10 * TICK_HZ, 101).torpedoes[0];
    expect(after?.phase).not.toBe('launch');
    expect(after?.speed).toBeCloseTo(getWeapon('active-torpedo').speed, 6);
    // And it went where it was sent rather than round the houses.
    expect(after?.pos.y).toBeGreaterThan(0);
  });

  it('holds the bearing for the settle time before opening the throttle', () => {
    // The knob (`content/weapons.ts#TORPEDO_LAUNCH_SETTLE_SECONDS`), and the whole of what it
    // does: a weapon that is on its heading stays on it, still creeping and still steering, for
    // this long before it goes. Asserted in ticks against the constant rather than against a
    // number written here, so turning the knob moves the test with it.
    const settleTicks = Math.round(TORPEDO_LAUNCH_SETTLE_SECONDS * TICK_HZ);
    let weapon = torpedo({
      firedTick: 100,
      phase: 'launch',
      facing: 0,
      speed: LAUNCH_SPEED,
      aim: { x: 900, y: 0 },
    });

    let held = -1;
    for (let tick = 101; tick <= 101 + settleTicks + 5 && held < 0; tick += 1) {
      const next = step([], [weapon], tick).torpedoes[0];
      expect(next).toBeDefined();
      weapon = next as TorpedoState;
      // Aligned from the very first tick — a shot straight ahead has nothing to get round — so
      // what it is waiting out here is the hold and nothing else.
      expect(weapon.alignedTick).toBe(101);
      if (weapon.phase !== 'launch') held = tick - 101;
    }

    expect(held).toBe(settleTicks);
  });

  it('starts the hold again if it comes off its heading', () => {
    // Time spent *settled*, not time since first touching the mark. Otherwise a weapon knocked
    // off its bearing at the end of the hold would open the throttle pointing the wrong way,
    // which is the thing the hold exists to prevent.
    const settleTicks = Math.round(TORPEDO_LAUNCH_SETTLE_SECONDS * TICK_HZ);
    let weapon = torpedo({
      firedTick: 100,
      phase: 'launch',
      facing: 0,
      speed: LAUNCH_SPEED,
      aim: { x: 900, y: 0 },
    });

    // Most of the way through the hold, and then sent somewhere else entirely.
    for (let tick = 101; tick < 101 + settleTicks; tick += 1) {
      weapon = step([], [weapon], tick).torpedoes[0] as TorpedoState;
    }
    expect(weapon.phase).toBe('launch');

    const diverted = step([], [{ ...weapon, aim: { x: 0, y: 900 } }], 101 + settleTicks)
      .torpedoes[0];
    expect(diverted?.alignedTick).toBe(0);
    expect(diverted?.phase).toBe('launch');
  });

  it('hands every load over *on* its heading rather than near it', () => {
    /*
     * The regression this exists for, and why it was only visible on three of the four loads.
     *
     * A weapon that opens the throttle a few degrees off has to finish the turn at cruising
     * speed, on a circle five to twenty times wider than the one it was turning on — a
     * super-cavitating weapon goes from forty metres to three hundred and fifteen. The standard
     * torpedo hides that: its seeker re-aims it on the way in. Nothing else in the table homes,
     * so the drone, the decoy and the super-cavitating torpedo fly the heading handed over here
     * and a few degrees of slop lands as tens of metres at the aim point.
     *
     * Checked against the plain bearing to the aim point, because with the pitch band gone that
     * is the only heading in play: there is no clamped demand the weapon settles for instead and
     * nothing takes any of the angle back when the throttle opens (`content/weapons.ts`).
     */
    for (const weapon of DEPLOYABLE_WEAPON_IDS) {
      const def = getWeapon(weapon);
      // Ninety degrees off the bow: the longest turn a launch can be asked for that is not a
      // reversal, and the one where a tolerance would show up.
      let running = torpedo({
        weapon,
        firedTick: 100,
        phase: 'launch',
        facing: 0,
        speed: LAUNCH_SPEED,
        pos: { x: 0, y: 0 },
        aim: { x: 0, y: 900 },
        ...(def.behaviour === 'decoy' ? { mimic: { hull: 'medium', stats: STATS } } : {}),
      });

      let left: TorpedoState | undefined;
      for (let tick = 101; tick <= 101 + 30 * TICK_HZ && left === undefined; tick += 1) {
        const next = step([], [running], tick).torpedoes[0];
        if (next === undefined) break;
        if (next.phase !== 'launch') left = next;
        running = next;
      }

      expect(left, `${weapon} never left the launch phase`).toBeDefined();
      const demand = bearingDeg((left ?? running).pos, running.aim);
      const error = Math.abs(headingDelta(left?.facing ?? 0, demand));
      expect(error, `${weapon} left the launch phase ${error.toFixed(1)}° off`).toBeLessThanOrEqual(
        TORPEDO_LAUNCH_ALIGNMENT,
      );
      // And it is one tick of this weapon's own turn or less, which is the point of the number:
      // "it has arrived on the heading", not "it is nearly there".
      expect(TORPEDO_LAUNCH_ALIGNMENT).toBeLessThanOrEqual(def.turnRate / TICK_HZ);
    }
  });

  it('climbs at a point directly overhead instead of creeping under it forever', () => {
    /*
     * The regression that cost a torpedo its whole life, and the reason the pitch band was hard
     * to keep honest. `clampPitch` pulled a heading into whichever wedge was *nearer*, so for a
     * point within a degree or two of straight up the demand swung the entire way across — 60° to
     * 120° at the edge of the launch band — the instant the weapon's own drift carried it past
     * the point's horizontal position. The weapon chased a demand that changed sides faster than
     * it could turn and never settled: measured at 2699 ticks, 135 seconds, creeping at launch
     * speed until its clock ran out. Side-pinning the demand was the fix; removing the band
     * removes the question.
     *
     * Straight up is now an ordinary bearing, so the weapon turns 90° onto it and goes.
     */
    let weapon = torpedo({
      firedTick: 100,
      phase: 'launch',
      facing: 0,
      speed: LAUNCH_SPEED,
      pos: { x: 0, y: 0 },
      aim: { x: 0, y: 2000 },
    });

    let ticks = -1;
    for (let tick = 101; tick <= 101 + 30 * TICK_HZ && ticks < 0; tick += 1) {
      weapon = step([], [weapon], tick).torpedoes[0] as TorpedoState;
      if (weapon.phase !== 'launch') ticks = tick - 101;
    }

    // Out in seconds rather than never: the turn is 90° at 25 °/s plus the hold.
    expect(ticks).toBeGreaterThan(0);
    expect(ticks).toBeLessThan(6 * TICK_HZ);
    // Pointing at the thing it was sent to, not at the edge of a band beside it.
    expect(weapon.facing).toBeCloseTo(90, 0);
  });

  it('commits to a run on an aim point inside its own turn instead of creeping under it forever', () => {
    // The valve in `settle`. A point inside (or near) the weapon's turn circle can never be
    // pointed at: the demand keeps swinging as the weapon circles it, so the alignment hold
    // never lands and "on the bearing" never comes. Before the valve it crept at launch speed
    // beside the point for its whole life and died on the lifetime clock, having gained nothing
    // either. Once it has had the settling window to align, arrival is the honest exit.
    const creep = torpedo({
      weapon: 'super-cavitating',
      firedTick: 100,
      phase: 'launch',
      facing: 45,
      speed: LAUNCH_SPEED,
      pos: { x: 0, y: 0 },
      aim: { x: 49.9, y: 2.6 },
    });

    let weapon = creep;
    let left = -1;
    for (let tick = 101; tick <= 101 + 30 * TICK_HZ && left < 0; tick += 1) {
      const next = step([], [weapon], tick).torpedoes[0];
      if (next === undefined) break;
      if (next.phase !== 'launch') left = tick - 101;
      weapon = next;
    }

    expect(left, 'never left the launch phase').toBeGreaterThanOrEqual(0);
    // The turn to first touch the aim plus the settling window, not the lifetime clock.
    expect(left).toBeLessThan(10 * TICK_HZ);
    // And it was never on the heading: the valve fired, not the alignment hold.
    expect(weapon.alignedTick).toBe(0);
  });

  it('turns onto a point astern instead of braking and mirroring', () => {
    /*
     * The manoeuvre that went with the pitch band. A weapon sent behind itself used to take the
     * way off and reflect `facing` about the vertical, exactly as `match/movement.ts` has
     * submarines do, because a band around horizontal left it no way to rotate through the
     * vertical at all. With the band gone the rotation is available and the flip buys nothing:
     * the weapon is creeping at `LAUNCH_SPEED` while it comes about, so the circle it sweeps is
     * tens of metres rather than the fifty to three hundred it would sweep at cruise.
     *
     * The tells are both here: it keeps its speed, and it leaves the line it was launched on.
     */
    const astern = torpedo({
      firedTick: 100,
      phase: 'launch',
      facing: 0,
      speed: LAUNCH_SPEED,
      pos: { x: 0, y: 0 },
      aim: { x: -900, y: 0 },
    });

    const after = run([], [astern], 10 * TICK_HZ, 101).torpedoes[0] as TorpedoState;
    // Come about. Not pinned to the degree: it is still steering at the aim point, and having
    // swung off the launch line to get there it is chasing a bearing a degree or two off astern.
    expect(Math.abs(headingDelta(after.facing, 180))).toBeLessThan(5);
    // Never gave up the way it had on. A flip would have taken it to zero within a quarter of a
    // second and then rebuilt it.
    expect(after.speed).toBeGreaterThanOrEqual(LAUNCH_SPEED);
    // And it swung off the launch line to get round rather than reflecting along it.
    expect(Math.abs(after.pos.y)).toBeGreaterThan(10);
    // On its way back, past where it started.
    expect(after.pos.x).toBeLessThan(0);
  });

  it('does not brake for a target astern once it is up to speed', () => {
    // Nothing in the water brakes to turn any more, but this is the case that mattered most when
    // something did: a homing torpedo that stopped dead whenever its track went behind it would
    // be unmissable. The miss it ought to have is the point.
    const past = torpedo({
      phase: 'enabled',
      firedTick: 0,
      facing: 0,
      speed: getWeapon('active-torpedo').speed,
      track: { x: -400, y: 0 },
      trackTick: 100,
      lastPingTick: 100,
    });

    expect(step([], [past], 101).torpedoes[0]?.speed).toBe(getWeapon('active-torpedo').speed);
  });
});

describe('the drone', () => {
  const drone = (overrides: Partial<TorpedoState> = {}): TorpedoState =>
    torpedo({ weapon: 'drone', speed: getWeapon('drone').speed, ...overrides });

  it('does not stop when it arrives — it wakes up and runs straight on', () => {
    // The aim point is where the sonar comes on, not a station. What a drone draws is a transect
    // along the line it was sent down, and it cannot be talked off that line.
    const arriving = drone({
      firedTick: 100,
      phase: 'running',
      facing: 0,
      pos: { x: 0, y: 0 },
      aim: { x: 5, y: 0 },
    });
    const after = run([], [arriving], 4 * TICK_HZ, 101).torpedoes[0];

    expect(after?.phase).toBe('enabled');
    expect(after?.speed).toBe(getWeapon('drone').speed);
    // Well past the point it woke up at, still on the same bearing.
    expect(after?.pos.x).toBeGreaterThan(getWeapon('drone').speed * 3);
    expect(after?.pos.y).toBe(0);
    expect(after?.facing).toBe(0);
  });

  it('holds its bearing afterwards, however far the aim point falls behind it', () => {
    // The super-cavitating weapon's rule, and for a load with no warhead it is the same rule:
    // arrival stops the steering. A drone that could be re-aimed would be a boat.
    const past = drone({
      firedTick: 100,
      phase: 'enabled',
      facing: 0,
      pos: { x: 400, y: 0 },
      // Well off to one side. A weapon that still steered would turn hard toward it.
      aim: { x: 200, y: 900 },
    });

    const after = run([], [past], 10 * TICK_HZ, 101).torpedoes[0];
    expect(after?.facing).toBe(0);
    expect(after?.pos.y).toBe(0);
  });

  it('pulses once awake, on its own slower rhythm, and not on the way out', () => {
    const transiting = drone({ firedTick: 100, phase: 'running', aim: { x: 4000, y: 0 } });
    expect(step([], [transiting], 101).torpedoes[0]?.lastPingTick).toBe(0);

    const awake = drone({ firedTick: 100, phase: 'enabled' });
    const first = step([], [awake], 101).torpedoes[0];
    expect(first?.lastPingTick).toBe(101);

    // Two seconds, not the seeker's one. Nothing at 101 + 20 ticks; a pulse at 101 + 40.
    expect(step([], [first as TorpedoState], 121).torpedoes[0]?.lastPingTick).toBe(101);
    expect(step([], [first as TorpedoState], 141).torpedoes[0]?.lastPingTick).toBe(141);
  });

  it('never homes on what its pulse came back off', () => {
    // It has no warhead to chase with, and a drone that turned after a contact would stop being
    // the one predictable sensor its team owns. What its ping is *for* is the ocean it lights.
    const target = boat({ id: 2, team: 'team2', pos: { x: 120, y: 0 } });
    const awake = drone({ firedTick: 100, phase: 'enabled' });

    const after = step([target], [awake], 101).torpedoes[0];
    expect(after?.lastPingTick).toBe(101);
    expect(after?.track).toBeNull();
  });

  it('scuttles at the end of its watch instead of going off', () => {
    // No warhead, no bang, and nothing reported. A spent weapon only lingers to let its
    // detonation ring down, so one with no detonation leaves on the very next tick.
    const end = Math.ceil(getWeapon('drone').lifetimeSeconds * TICK_HZ);
    const old = drone({ firedTick: 0, phase: 'enabled' });
    const after = step([], [old], end);

    expect(after.detonations).toHaveLength(0);
    expect(after.torpedoes[0]?.phase).toBe('spent');
    expect(after.torpedoes[0]?.transients).toEqual([]);
    expect(step([], after.torpedoes, end + 1).torpedoes).toHaveLength(0);
  });
});

describe('the active decoy', () => {
  const decoy = (overrides: Partial<TorpedoState> = {}): TorpedoState =>
    torpedo({
      weapon: 'active-decoy',
      mimic: { hull: 'medium', stats: STATS },
      speed: STATS.maxSpeed,
      ...overrides,
    });

  it('runs at the flank speed of the boat that fired it, not at the table’s number', () => {
    // A false contact that could be outrun by the thing it is imitating is a false contact for
    // about ten seconds.
    const running = decoy({ firedTick: 100, phase: 'running', speed: 0, aim: { x: 4000, y: 0 } });
    const after = run([], [running], 4 * TICK_HZ, 101).torpedoes[0];

    expect(STATS.maxSpeed).not.toBe(getWeapon('active-decoy').speed);
    expect(after?.speed).toBeCloseTo(STATS.maxSpeed, 6);
  });

  it('seduces a seeker, which has no way to tell it from the boat it imitates', () => {
    // `seeker.ts` promises a weapon that holds a position rather than an entity can be decoyed.
    // This is that promise: the decoy reflects the mimicked hull's silhouette and absorption, so
    // the seeker hears a submarine and steers at one.
    const bait = decoy({ id: 200, team: 'team1', pos: { x: 150, y: 0 }, phase: 'running' });
    const seeking = torpedo({ id: 201, team: 'team2', firedTick: 0, phase: 'enabled', facing: 0 });

    const after = step([], [bait, seeking], 101).torpedoes.find((t) => t.id === 201);
    expect(after?.track).toEqual({ x: 150, y: 0 });
  });

  it('seduces a passive seeker too, which hears the noise it is radiating', () => {
    // The same promise kept for the other receiver, and it has to be kept *separately* — the
    // active seeker is fooled by the mimicked hull's absorption and this one by its source level,
    // so a decoy that reached the solver as a boat but the passive path as a torpedo would be a
    // decoy that works against exactly half the weapons in the game.
    //
    // A decoy runs at the flank speed of the boat it imitates, so it is a *loud* false contact:
    // it is heard from further out than the submarine standing still beside it would be, which is
    // the trap working rather than a leak.
    const bait = decoy({ id: 200, team: 'team1', pos: { x: 150, y: 0 }, phase: 'running' });
    const listening = torpedo({
      id: 201,
      weapon: 'passive-torpedo',
      team: 'team2',
      firedTick: 0,
      phase: 'enabled',
    });

    const after = step([], [bait, listening], 101).torpedoes.find((t) => t.id === 201);
    expect(after?.track).toEqual({ x: 150, y: 0 });
    expect(after?.lastPingTick).toBe(0);
  });

  it('ends quietly, so its last second is not the announcement that it was a decoy', () => {
    const end = Math.ceil(getWeapon('active-decoy').lifetimeSeconds * TICK_HZ);
    const old = decoy({ firedTick: 0, phase: 'running' });
    const after = step([], [old], end);

    expect(after.detonations).toHaveLength(0);
    expect(after.torpedoes[0]?.transients).toEqual([]);
    expect(step([], after.torpedoes, end + 1).torpedoes).toHaveLength(0);
  });
});
