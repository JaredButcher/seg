/**
 * The countermeasure: the launcher, the drop, the sink, and the two ways it beats a seeker.
 *
 * `weapons-phase` covers the run-out every *tube* load shares. A noisemaker shares almost none of
 * it — it is dropped rather than fired, born `enabled`, and steers at nothing — so it gets its own
 * file rather than a handful of exceptions bolted onto that one.
 *
 * The two assertions this exists for are the pair the whole mechanic rests on, and they are
 * deliberately opposite:
 *
 * - a **passive** seeker is *distracted* — it hunts the loudest thing off its nose, and that is now
 *   the noisemaker rather than the boat;
 * - an **active** seeker is *blinded* — it cannot be distracted by a drum, so the racket goes into
 *   the floor its own echo has to clear and the weapon acquires nothing at all.
 *
 * Everything else here is the bookkeeping that has to be right for those two to mean anything: that
 * a drop really costs the launcher a reload, that the thing sinks, and that it dies quietly.
 */

import {
  canDrop,
  COUNTERMEASURE_DROP_HEADING,
  countermeasureReloadSecondsFor,
  describeLauncherProblem,
  dropCountermeasure,
  dropped,
  getHull,
  getWeapon,
  HOLDING,
  isTubeWeapon,
  newLauncher,
  newTube,
  NOISEMAKER_SINK_SPEED,
  stepLauncher,
  stepWeapons,
  type BoatState,
  type TorpedoState,
  type WeaponsOutcome,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

const TICK_HZ = 20;
const STATS = getHull('medium').stats;
const NOISEMAKER = getWeapon('noisemaker');

/** The same shape `weapons-phase` uses, and the same reason: depths, and nothing else. */
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
    weaponSubstitutions: {},
    moduleModifiers: [],
    pos: { x: 0, y: 1000 },
    facing: 0,
    speed: 0,
    throttle: 'slow',
    hp: STATS.maxHp,
    tubes: [newTube(0, 'active-torpedo')],
    countermeasure: newLauncher(),
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
    team: 'team2',
    owner: 'a2',
    firedBy: 9,
    firedTick: 0,
    aim: { x: 1000, y: 1000 },
    mimic: null,
    pos: { x: 0, y: 1000 },
    facing: 0,
    speed: getWeapon('active-torpedo').speed,
    travelled: 0,
    phase: 'enabled',
    alignedTick: 0,
    track: null,
    trackTick: 0,
    lastPingTick: 0,
    transients: [],
    ...overrides,
  };
}

/** One noisemaker sitting where the test wants it, with nothing else about it interesting. */
function noisemaker(at: { x: number; y: number }, overrides: Partial<TorpedoState> = {}) {
  return torpedo({
    id: 200,
    weapon: 'noisemaker',
    team: 'team1',
    owner: 'a1',
    firedBy: 1,
    facing: COUNTERMEASURE_DROP_HEADING,
    speed: NOISEMAKER_SINK_SPEED,
    phase: 'enabled',
    pos: at,
    aim: at,
    ...overrides,
  });
}

function step(
  boats: readonly BoatState[],
  torpedoes: readonly TorpedoState[],
  tick = 100,
): WeaponsOutcome {
  return stepWeapons({ boats, torpedoes, terrain: null, extents: EXTENTS, tick, tickHz: TICK_HZ });
}

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

describe('the countermeasure launcher', () => {
  it('starts a match ready, with nothing to decide about it', () => {
    const launcher = newLauncher();
    expect(launcher.status).toBe('ready');
    expect(canDrop(launcher)).toBe(true);
    expect(describeLauncherProblem(launcher)).toBeNull();
  });

  it('reloads on its own clock, so a torpedo loader module leaves it alone', () => {
    // Its own stat (`countermeasureReloadSeconds`), not a tube's `reloadSeconds` — a boat that
    // fitted Rapid Loader and not Countermeasure Reloader gets faster tubes and a launcher
    // exactly as slow as it started.
    expect(dropped(newLauncher(), STATS).readyInSeconds).toBe(
      countermeasureReloadSecondsFor(STATS),
    );

    const quick = { ...STATS, countermeasureReloadSeconds: STATS.countermeasureReloadSeconds / 2 };
    expect(dropped(newLauncher(), quick).readyInSeconds).toBe(
      countermeasureReloadSecondsFor(quick),
    );

    // And a faster *tube* reload alone changes nothing about it.
    const fasterTubes = { ...STATS, reloadSeconds: STATS.reloadSeconds / 2 };
    expect(dropped(newLauncher(), fasterTubes).readyInSeconds).toBe(
      countermeasureReloadSecondsFor(STATS),
    );
  });

  it('refuses a second drop until it has refilled, and says why', () => {
    const spent = dropped(newLauncher(), STATS);
    expect(canDrop(spent)).toBe(false);
    expect(describeLauncherProblem(spent)).toBe('The countermeasure launcher is reloading.');

    const nearly = stepLauncher(spent, countermeasureReloadSecondsFor(STATS) - 0.5);
    expect(canDrop(nearly)).toBe(false);
    expect(canDrop(stepLauncher(nearly, 0.5))).toBe(true);
  });

  it('is stepped by the weapons phase, with nothing in the water at all', () => {
    // The launcher rides on the same pass that turns the tubes over, which is the one place
    // anything advances it (`sim/weapons/phase.ts#stepTubes`).
    const spent = boat({ countermeasure: dropped(newLauncher(), STATS) });
    const after = step([spent], []).boats[0];

    expect(after?.countermeasure.status).toBe('reloading');
    expect(after?.countermeasure.readyInSeconds).toBeCloseTo(
      countermeasureReloadSecondsFor(STATS) - 1 / TICK_HZ,
    );
  });

  it('hands back the same fleet when no tube and no launcher is cycling', () => {
    const idle = [boat()];
    expect(step(idle, []).boats).toBe(idle);
  });
});

describe('dropping one', () => {
  it('puts it under the boat, pointed down, already sinking', () => {
    const dropping = boat({ pos: { x: 500, y: 900 }, facing: 45 });
    const { boat: after, noisemaker: made } = dropCountermeasure({
      boat: dropping,
      id: 42,
      tick: 40,
      tickHz: TICK_HZ,
    });

    // Straight down from the boat's centre, clear of a hull that is 140 m long — and *below* it
    // whatever attitude the boat is in, which is the whole difference from a tube.
    expect(made.pos.x).toBe(500);
    expect(made.pos.y).toBeLessThan(900 - getHull('medium').length / 2);
    expect(made.facing).toBe(COUNTERMEASURE_DROP_HEADING);
    // No run-out, no wind-up: it is where it is going to be and doing what it will do.
    expect(made.phase).toBe('enabled');
    expect(made.speed).toBe(NOISEMAKER_SINK_SPEED);

    expect(after.countermeasure.status).toBe('reloading');
    expect(after.transients).toContainEqual({ kind: 'countermeasure-drop', tick: 40 });
  });

  /*
   * The invariant the two assertions above cannot make, because they name a number.
   *
   * Every `facing` in the game is normalized to `[0, 360)`: anything that steers ends up there by
   * construction, because `turnToward` and `bearingTo` both finish with `normalizeDeg`. The binary
   * codec encodes the field as a `u16` of hundredths of a degree on exactly that assumption
   * (`protocol/binary/messages.ts#ANGLE_STEP`), so a negative one is not a cosmetic difference — it
   * is a throw on the publish tick that takes the whole match's tick with it.
   *
   * **A noisemaker is the only thing in the water that never steers.** It is born `enabled` and
   * `stepTorpedo` passes its facing through untouched for its entire life, so nothing was ever
   * going to normalize this on its behalf, and a `-90` written at construction reached the wire
   * intact. It shipped, and the first player to press the drop key hung their match.
   *
   * Asserted as a range rather than a value on purpose: the two tests either side of this one would
   * both pass with a heading of `-90`, because they were written against it.
   */
  it('is dropped on a heading the wire can carry', () => {
    const made = dropCountermeasure({
      boat: boat({ pos: { x: 500, y: 900 }, facing: 45 }),
      id: 42,
      tick: 40,
      tickHz: TICK_HZ,
    }).noisemaker;

    expect(made.facing).toBeGreaterThanOrEqual(0);
    expect(made.facing).toBeLessThan(360);

    // And it stays there: the thing sinks without ever being steered, so if the phase machinery
    // did touch its heading this is where that would show up. Ten seconds, comfortably inside its
    // clock — a run past `lifetimeSeconds` scuttles it and there is no torpedo left to read.
    const late = run([], [made], 10 * TICK_HZ).torpedoes[0];
    expect(late?.facing).toBeGreaterThanOrEqual(0);
    expect(late?.facing).toBeLessThan(360);

    // Still straight down, which is the point of the heading in the first place.
    expect(Math.cos((made.facing * Math.PI) / 180)).toBeCloseTo(0, 10);
    expect(Math.sin((made.facing * Math.PI) / 180)).toBeCloseTo(-1, 10);
  });

  it('sinks straight down and does not drift', () => {
    const made = noisemaker({ x: 300, y: 1000 });
    const after = run([], [made], 10 * TICK_HZ).torpedoes[0];

    expect(after?.pos.x).toBeCloseTo(300);
    expect(after?.pos.y).toBeCloseTo(1000 - NOISEMAKER_SINK_SPEED * 10, 1);
    expect(after?.facing).toBe(COUNTERMEASURE_DROP_HEADING);
  });

  it('dies on its clock, quietly and with no bang', () => {
    // A load with no warhead scuttles rather than detonating, and a countermeasure especially: a
    // bang at the end would tell the listener who was chasing it exactly what it had been.
    const made = noisemaker({ x: 0, y: 1500 });
    const after = run([], [made], Math.ceil(NOISEMAKER.lifetimeSeconds * TICK_HZ) + 2);

    expect(after.torpedoes).toHaveLength(0);
    expect(after.detonations).toHaveLength(0);
  });

  it('cannot be put in a tube', () => {
    // Deployable, and still not something a tube may hold: it has a launcher of its own, and a
    // tube holding one would have cost the boat a torpedo for something it already has.
    expect(NOISEMAKER.deployable).toBe(true);
    expect(isTubeWeapon('noisemaker')).toBe(false);
  });
});

describe('what it does to a passive seeker', () => {
  /**
   * The weapon 200 m short of a boat running at its highest *quiet* notch.
   *
   * `full` rather than `flank`, and the difference is not incidental — it is the mechanic. At full
   * the boat radiates 57 dB and reaches the weapon at about 34, comfortably over the seeker's gate
   * and comfortably under a noisemaker. At flank it is cavitating and radiating 109, which no
   * countermeasure in the table can beat; the last test in this block is that case, on purpose.
   */
  const at = { x: 200, y: 1000 };
  const target = boat({ id: 2, team: 'team2', pos: at, speed: STATS.cavitationSpeed - 1 });
  const listening = torpedo({ weapon: 'passive-torpedo', firedTick: 0, phase: 'enabled' });

  it('is the loudest thing off the nose, so the weapon goes for it instead', () => {
    // The control: with nothing else in the water it hears the boat and tracks the boat.
    expect(step([target], [listening]).torpedoes[0]?.track).toEqual(at);

    // And with a noisemaker between them it tracks the noisemaker. Nothing in the weapon knows it
    // has been had — it went for the loudest contact, which is what it was built to do.
    const between = { x: 120, y: 1000 };
    const fooled = step([target], [listening, noisemaker(between)]).torpedoes[0];
    expect(fooled?.track).toEqual(between);
  });

  it('is not heard from astern, so it has to be put between you and the weapon', () => {
    // `SEEKER_ARC` gates every candidate, and a countermeasure is a candidate. That is what makes
    // the tactic a decision rather than a button: dropped behind the weapon it does nothing.
    const behind = step([target], [listening, noisemaker({ x: -300, y: 1000 })]).torpedoes[0];
    expect(behind?.track).toEqual(at);
  });

  it('is eaten by the water like everything else, so it has to be dropped near the weapon', () => {
    // Two kilometres out a noisemaker is under the seeker's own gate — it is not a quiet jammer
    // there, it is nothing at all. The comparison is at the weapon's position, always.
    const far = step([target], [listening, noisemaker({ x: 2400, y: 1000 })]).torpedoes[0];
    expect(far?.track).toEqual(at);
  });

  it('cannot hide a boat that is cavitating, which is the counter to the counter', () => {
    // A Medium at flank radiates 109 dB and reaches the weapon at 85; the noisemaker at 120 m
    // reaches it at 77. So the boat wins, the weapon keeps coming, and the defence is the one the
    // game already asks for everywhere else: slow down *first*, then drop. Turn `sourceLevel` down
    // in `content/weapons.ts` if noisemakers ever start beating this case.
    const loud = boat({ id: 2, team: 'team2', pos: at, speed: STATS.maxSpeed });
    const still = step([loud], [listening, noisemaker({ x: 120, y: 1000 })]).torpedoes[0];
    expect(still?.track).toEqual(at);
  });
});

describe('what it does to an active seeker', () => {
  /** A hull well inside the ~345 m an active seeker manages against a bare Medium. */
  const target = boat({ id: 2, team: 'team2', pos: { x: 200, y: 1000 } });
  const pinging = torpedo({ weapon: 'active-torpedo', firedTick: 0, phase: 'enabled' });

  it('buries the echo, so the weapon acquires nothing at all', () => {
    // The control: the pulse finds the hull.
    expect(step([target], [pinging]).torpedoes[0]?.track).toEqual({ x: 200, y: 1000 });

    // And with a noisemaker in earshot the same pulse comes back into a floor it cannot clear.
    const jammed = step([target], [pinging, noisemaker({ x: 150, y: 1000 })]).torpedoes[0];
    expect(jammed?.track).toBeNull();
  });

  it('does not silence the pulse — the weapon still announces itself every second', () => {
    // What a noisemaker takes away is only what comes *back*. A jammed weapon is a blind weapon,
    // not a quiet one, and the target still gets the bearing that tells them it is coming.
    const jammed = step([target], [pinging, noisemaker({ x: 150, y: 1000 })]).torpedoes[0];
    expect(jammed?.lastPingTick).toBe(100);
  });

  it('is not a distraction: an active seeker never steers at one', () => {
    // A drum returns nothing worth chasing, so `seekerLook`'s candidates are hulls and decoys and
    // nothing else. The blinding is the whole of the active seeker's story.
    const alone = step([], [pinging, noisemaker({ x: 150, y: 1000 })]).torpedoes[0];
    expect(alone?.track).toBeNull();
  });

  it('stops mattering with range, rather than switching off at a line', () => {
    // Two kilometres ahead — inside the arc, so this is about *distance* and not about the arc —
    // and the water has eaten it: the seeker's floor comes back down and the hull is found again.
    // That gradient is `sim/acoustics`'s own arithmetic and not a curve anyone wrote down, which is
    // what makes "how close do I have to drop it" a thing a player can learn.
    const far = step([target], [pinging, noisemaker({ x: 2000, y: 1000 })]).torpedoes[0];
    expect(far?.track).toEqual({ x: 200, y: 1000 });
  });

  it('does not jam from astern either, the same arc the passive seeker listens through', () => {
    // One rule for both receivers: a countermeasure works on a weapon that is pointed at it. A
    // receiver's gain is a gain in the direction it is looking, and "put it between yourself and
    // the weapon" is a decision where "drop one anywhere" would not be.
    const behind = step([target], [pinging, noisemaker({ x: -150, y: 1000 })]).torpedoes[0];
    expect(behind?.track).toEqual({ x: 200, y: 1000 });
  });

  it('jams from either side, because a countermeasure has no team', () => {
    // Friendly fire is on everywhere else (Q7) and it is on here too: a noisemaker that blinded
    // only the enemy would be one a player could drop into their own salvo for nothing.
    const own = noisemaker({ x: 150, y: 1000 }, { team: 'team2', owner: 'a2' });
    expect(step([target], [pinging, own]).torpedoes[0]?.track).toBeNull();
  });
});
