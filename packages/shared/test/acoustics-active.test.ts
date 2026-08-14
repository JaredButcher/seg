/**
 * Active sonar, as an acoustic event (planning/03 §3).
 *
 * The claim these tests are defending is that **a ping is a transient and nothing more**. There
 * is no ping phase in the solver, no wavefront, and no echo queue; there is a boat that becomes
 * enormously loud for four tenths of a second, and every consequence — the cave walls lighting
 * up, the enemy getting a bearing — falls out of machinery that already existed. If that ever
 * stops being true, these are the tests that should have to change.
 */

import { describe, expect, it } from 'vitest';

import {
  ACOUSTICS,
  activePingLevel,
  boatEntity,
  deployMatch,
  emittedLevels,
  generateMap,
  getHull,
  getWeapon,
  HULL_IDS,
  pingDue,
  pingLevelOf,
  resolveBoat,
  SIM_TICK_HZ,
  sourceLevelOf,
  ticksPerPing,
  toDecibels,
  toPower,
  torpedoEmittedLevels,
  torpedoEntity,
  TRANSIENT_NOISE_FRACTION,
  TRANSIENTS,
  withTransient,
  type BoatState,
  type BoatTemplate,
  type TorpedoState,
  type TransientKind,
} from '../src/index.js';

const MEDIUM: BoatTemplate = { name: 'S-01', hull: 'medium', modules: [] };

/** One deployed boat, so the state under test is the one the game actually produces. */
function boat(template: BoatTemplate = MEDIUM): BoatState {
  const state = deployMatch({
    matchId: 'm1',
    mode: 'deathmatch',
    map: generateMap('empty', { seed: 5, mapSize: 'small' }),
    startedAt: 0,
    players: [{ accountId: 'a', username: 'a', position: 'team1', boats: [template] }],
  });
  const first = state.boats[0];
  if (first === undefined) throw new Error('deployment produced no boats');
  return first;
}

describe('a pulse ringing down', () => {
  it('is at full strength the instant it fires', () => {
    expect(activePingLevel(120, 0)).toBe(120);
  });

  it('falls linearly to nothing across its length', () => {
    const half = ACOUSTICS.pingSeconds / 2;
    expect(activePingLevel(120, half)).toBeCloseTo(60, 6);
  });

  /*
   * `-Infinity` rather than zero, because zero is not silence on this scale — it is the level
   * of the quiet ocean (`content/acoustics.ts` header). A pulse that decayed to zero would go
   * on power-summing an ambient's worth of noise into its boat forever.
   */
  it('is silent once it has run out, and before it started', () => {
    expect(activePingLevel(120, ACOUSTICS.pingSeconds)).toBe(-Infinity);
    expect(activePingLevel(120, 99)).toBe(-Infinity);
    expect(activePingLevel(120, -0.1)).toBe(-Infinity);
  });

  it('rings down inside one interval, so pulses never overlap', () => {
    expect(ACOUSTICS.pingSeconds * 1000).toBeLessThan(ACOUSTICS.pingIntervalMs);
  });
});

describe('the pulse interval', () => {
  it('is two seconds, and forty sim ticks at the shipped rate', () => {
    expect(ACOUSTICS.pingIntervalMs).toBe(2000);
    expect(ticksPerPing(SIM_TICK_HZ)).toBe(40);
  });

  it('never rounds to zero, however slow the clock', () => {
    expect(ticksPerPing(1)).toBeGreaterThanOrEqual(1);
  });
});

describe('when a boat is due to pulse', () => {
  it('is never, with the switch off', () => {
    expect(pingDue({ ...boat(), activeSonar: false }, 1_000, SIM_TICK_HZ)).toBe(false);
  });

  /*
   * At once, which is the responsiveness of the whole control: a boat that has been passive has
   * already served the interval, so the switch is answered on the very next tick and the wait
   * is for the *second* pulse.
   */
  it('is at once on a boat that has never pinged', () => {
    const fresh = { ...boat(), activeSonar: true, lastPingTick: 0 };
    expect(pingDue(fresh, 1, SIM_TICK_HZ)).toBe(true);
    expect(pingDue(fresh, 600, SIM_TICK_HZ)).toBe(true);
  });

  /*
   * And that zero must not also read as a pulse. The two meanings share a value, so the one
   * place it matters — what the boat is *radiating* — has to say which it is, or a boat with
   * its sonar switched on at tick zero would broadcast a pulse that never happened.
   */
  it('has not already fired one, on a boat that has never pinged', () => {
    expect(pingLevelOf({ ...boat(), activeSonar: true, lastPingTick: 0 }, 2, SIM_TICK_HZ)).toBe(
      -Infinity,
    );
  });

  it('is one interval after the last pulse, and not before', () => {
    const pinging = { ...boat(), activeSonar: true, lastPingTick: 100 };
    expect(pingDue(pinging, 139, SIM_TICK_HZ)).toBe(false);
    expect(pingDue(pinging, 140, SIM_TICK_HZ)).toBe(true);
  });

  it('is never, on a wreck', () => {
    const dead = { ...boat(), activeSonar: true, lastPingTick: 0, status: 'destroyed' as const };
    expect(pingDue(dead, 500, SIM_TICK_HZ)).toBe(false);
    expect(pingLevelOf(dead, 500, SIM_TICK_HZ)).toBe(-Infinity);
  });
});

describe('what a pulse does to a boat’s source level', () => {
  it('is nothing at all while the switch is off', () => {
    expect(pingLevelOf({ ...boat(), activeSonar: false }, 0, SIM_TICK_HZ)).toBe(-Infinity);
  });

  /*
   * The number that matters. A stopped Medium radiates 48 dB; pinging it is 116, which is
   * roughly seventy decibels — a factor of ten million in power — above the boat it came out
   * of. "Pinging is always a map-wide announcement" (planning/03 §3) is not a rule anyone
   * wrote down in the solver; it is this arithmetic.
   */
  it('drowns out everything else the boat is doing', () => {
    const subject = { ...boat(), activeSonar: true, lastPingTick: 100 };
    const quiet = sourceLevelOf({ stats: subject.stats, speed: 0, depth: 200 });
    const ping = pingLevelOf(subject, 100, SIM_TICK_HZ);
    const loud = sourceLevelOf({
      stats: subject.stats,
      speed: 0,
      depth: 200,
      transients: [ping],
    });

    expect(ping).toBe(getHull('medium').stats.pingLevel);
    expect(loud).toBeGreaterThan(quiet + 60);
    // Power-summed rather than added: the pulse is so far above the hull noise that the sum is
    // the pulse, to within a hundredth of a decibel.
    expect(loud).toBeCloseTo(ping, 1);
  });

  it('is raised by Powerful Active Sonar, and by nothing else in the fleet editor', () => {
    const bare = resolveBoat(MEDIUM).current;
    const fitted = resolveBoat({
      ...MEDIUM,
      modules: [{ slot: 'equipment', index: 0, module: 'powerful-active-sonar' }],
    }).current;

    expect(fitted.pingLevel).toBe(bare.pingLevel + 8);
    // The trade is real and it is the *same number*: a pulse eight decibels stronger is a pulse
    // heard eight decibels further away. Nothing about the boat's own noise changed.
    expect(fitted.sourceLevel).toBe(bare.sourceLevel);
  });
});

/**
 * Everything a boat is radiating on top of its own machinery, each sound carrying how much of
 * itself a listener has to hear through.
 *
 * The point of `emittedLevels` is that a bang and a pulse arrive at the solver differently *on
 * purpose*: both are still part of the source level, but a bang deafens in full — it announces you
 * by raising everyone's noise floor — while a pulse carries `filterableNoiseFraction`, so it
 * announces you at full strength without deafening anyone to everything else. That is what keeps
 * "a collision announces you" true while still letting a listener hear *through* a ping.
 *
 * The fraction is a property of the sound rather than of a channel it was sorted into, so every
 * transient has one (`TransientDef.noiseFraction`). All nine take the default — `1`, the whole of
 * it — because there is nothing to notch out of broadband racket.
 */
describe('what a boat is radiating', () => {
  it('is nothing, on a quiet passive boat', () => {
    expect(emittedLevels(boat(), 100, SIM_TICK_HZ)).toEqual([]);
  });

  it('carries a bang, falling as it rings down', () => {
    const banged = withTransient(boat(), 'bottoming', 100, SIM_TICK_HZ);
    const [atOnce] = emittedLevels(banged, 100, SIM_TICK_HZ);
    const [later] = emittedLevels(banged, 140, SIM_TICK_HZ);

    expect(atOnce?.level).toBe(TRANSIENTS.bottoming.level);
    expect(later?.level).toBeLessThan(atOnce?.level ?? 0);
    // And it leaves the list entirely once it has reached the ambient, rather than sitting in it
    // at -Infinity: the solver is handed only what is actually making noise.
    expect(
      emittedLevels(banged, 100 + TRANSIENTS.bottoming.seconds * SIM_TICK_HZ, SIM_TICK_HZ),
    ).toEqual([]);
  });

  it('deafens in full with a bang and only a quarter with a ping', () => {
    const both = withTransient(
      { ...boat(), activeSonar: true, lastPingTick: 100 },
      'collision',
      100,
      SIM_TICK_HZ,
    );
    const levels = emittedLevels(both, 100, SIM_TICK_HZ);

    // A bang deafens you; a ping you can hear through. The fraction is the whole difference
    // between them, and neither sound knows the other is there.
    expect(levels).toEqual([
      { level: TRANSIENTS.collision.level, noiseFraction: 1 },
      {
        level: getHull('medium').stats.pingLevel,
        noiseFraction: ACOUSTICS.filterableNoiseFraction,
      },
    ]);
  });

  it('gives every transient in the table the full fraction, because a bang cannot be notched', () => {
    for (const kind of Object.keys(TRANSIENTS) as TransientKind[]) {
      const rung = withTransient(boat(), kind, 100, SIM_TICK_HZ);
      const [sound] = emittedLevels(rung, 100, SIM_TICK_HZ);
      expect(sound?.noiseFraction).toBe(TRANSIENT_NOISE_FRACTION);
    }
    expect(TRANSIENT_NOISE_FRACTION).toBe(1);
  });

  it('still rings its bangs on a wreck, but never pings — nobody is left to throw the switch', () => {
    const dead = withTransient(
      { ...boat(), activeSonar: true, lastPingTick: 100, status: 'destroyed' as const },
      'collision',
      100,
      SIM_TICK_HZ,
    );
    expect(emittedLevels(dead, 100, SIM_TICK_HZ)).toEqual([
      { level: TRANSIENTS.collision.level, noiseFraction: 1 },
    ]);
  });

  it('goes fully silent once a wreck has sunk out of the map', () => {
    const gone = withTransient(
      { ...boat(), status: 'destroyed' as const, pos: { ...boat().pos, y: -1 } },
      'collision',
      100,
      SIM_TICK_HZ,
    );
    expect(emittedLevels(gone, 100, SIM_TICK_HZ)).toEqual([]);
  });

  it('keeps the whole source level and names the part that deafens', () => {
    const subject = { ...boat(), activeSonar: true, lastPingTick: 100 };
    const extents = generateMap('empty', { seed: 5, mapSize: 'small' }).extents;
    const entity = boatEntity(
      subject,
      extents,
      emittedLevels(subject, 100, SIM_TICK_HZ, ACOUSTICS),
      ACOUSTICS,
    );
    const ping = getHull('medium').stats.pingLevel;

    // The boat is as loud as ever — a pinging boat is heard at full strength — and `deafeningLevel`
    // names what is left after a listener notches the tone out of its noise estimate: 6 dB down,
    // the pulse being so far above the hull's own 48 dB that it is the whole of both figures.
    expect(entity.sourceLevel).toBeCloseTo(ping, 1);
    expect(entity.deafeningLevel).toBeCloseTo(
      ping + 10 * Math.log10(ACOUSTICS.filterableNoiseFraction),
      1,
    );
  });

  it('deafens with everything it has when nothing filterable is ringing', () => {
    const banged = withTransient(boat(), 'bottoming', 100, SIM_TICK_HZ);
    const extents = generateMap('empty', { seed: 5, mapSize: 'small' }).extents;
    const entity = boatEntity(
      banged,
      extents,
      emittedLevels(banged, 100, SIM_TICK_HZ, ACOUSTICS),
      ACOUSTICS,
    );

    // The common case, and the one the solve is fastest on: nothing to skim, so the two levels are
    // the same number rather than two nearly equal ones.
    expect(entity.deafeningLevel).toBe(entity.sourceLevel);
  });
});

/**
 * The same fractions, on the torpedo that echoes a hull (`sim/acoustics/torpedoes.ts`).
 *
 * planning/04 §4 wants a weapon through exactly the same door as a submarine, and filterable sound
 * is part of that door now: an active torpedo's seeker pulse is a coherent tone at 95 dB and it
 * carries `filterableNoiseFraction` the way a boat's own ping does — a full-strength return that is
 * easy to hear through. The detonation is the opposite: a bang, and nothing to filter out of a
 * bang, so it deafens with all of itself.
 */
describe('what a torpedo is radiating', () => {
  const torpedo = (overrides: Partial<TorpedoState> = {}): TorpedoState => ({
    id: 100,
    weapon: 'active-torpedo',
    team: 'team2',
    owner: 'a2',
    firedBy: 1,
    firedTick: 0,
    aim: { x: 1000, y: 0 },
    pos: { x: 0, y: 0 },
    facing: 0,
    speed: getWeapon('active-torpedo').speed,
    travelled: 0,
    phase: 'running',
    track: null,
    trackTick: 0,
    lastPingTick: 0,
    mimic: null,
    transients: [],
    ...overrides,
  });

  it('is only its motor, while it runs with the seeker asleep', () => {
    expect(torpedoEmittedLevels(torpedo(), 100, SIM_TICK_HZ)).toEqual([]);
  });

  it('gives the seeker’s pulse the filterable fraction, once it has enabled', () => {
    const pinging = torpedo({ phase: 'enabled' as const, lastPingTick: 100 });

    expect(torpedoEmittedLevels(pinging, 100, SIM_TICK_HZ)).toEqual([
      {
        level: getWeapon('active-torpedo').seekerPingLevel,
        noiseFraction: ACOUSTICS.filterableNoiseFraction,
      },
    ]);
  });

  it('lets the detonation deafen in full, on a spent weapon', () => {
    const spent = torpedo({
      phase: 'spent' as const,
      transients: [{ kind: 'torpedo-detonation' as const, tick: 100 }],
    });

    expect(torpedoEmittedLevels(spent, 100, SIM_TICK_HZ)).toEqual([
      { level: TRANSIENTS['torpedo-detonation'].level, noiseFraction: 1 },
    ]);
  });

  it('keeps the whole source level and names the part that deafens', () => {
    const pinging = torpedo({ phase: 'enabled' as const, lastPingTick: 100 });
    const extents = generateMap('empty', { seed: 5, mapSize: 'small' }).extents;
    const entity = torpedoEntity(
      pinging,
      extents,
      torpedoEmittedLevels(pinging, 100, SIM_TICK_HZ, ACOUSTICS),
      ACOUSTICS,
    );
    const pulse = getWeapon('active-torpedo').seekerPingLevel;
    const motor = getWeapon('active-torpedo').sourceLevel;

    expect(entity.sourceLevel).toBeCloseTo(toDecibels(toPower(motor) + toPower(pulse)), 1);
    // The motor deafens in full, the pulse by a quarter — and the motor is not negligible here
    // the way a hull's own noise is under its own ping, so this is a genuine sum of the two.
    expect(entity.deafeningLevel).toBeCloseTo(
      toDecibels(toPower(motor) + toPower(pulse) * ACOUSTICS.filterableNoiseFraction),
      1,
    );
  });
});

/**
 * The transient table's scale, which is the one thing about it that is not a taste question.
 *
 * A transient is power-summed onto a boat's source level as an *absolute* level, so a bang quieter
 * than the boat making it is not a quiet bang — it is no bang at all. planning/03 §3's figures read
 * as absolute levels do exactly that (a 30 dB bottom contact raises a Heavy by 0.01 dB), which is
 * what `TRANSIENT_BASE` exists to correct. This is the assertion that stops it regressing.
 */
describe('the transient scale', () => {
  const loudestHullAtRest = Math.max(...HULL_IDS.map((id) => getHull(id).stats.sourceLevel));

  it('puts every transient meaningfully above the noisiest hull at rest', () => {
    for (const def of Object.values(TRANSIENTS)) {
      expect(def.level).toBeGreaterThan(loudestHullAtRest);
    }
  });

  it('makes even the quietest one actually change what a boat radiates', () => {
    const quietest = Math.min(...Object.values(TRANSIENTS).map((def) => def.level));
    const stats = getHull('heavy').stats;
    const bare = sourceLevelOf({ stats, speed: 0, depth: 200 });
    const banged = sourceLevelOf({ stats, speed: 0, depth: 200, transients: [quietest] });

    // A doubling of detection range is about 6 dB of source level in this model; the softest
    // transient in the table has to clear that or it is decoration.
    expect(banged - bare).toBeGreaterThan(6);
  });

  it('keeps every transient well under an active pulse, which stays the loudest choice', () => {
    const softestPing = Math.min(...HULL_IDS.map((id) => getHull(id).stats.pingLevel));
    for (const def of Object.values(TRANSIENTS)) {
      expect(def.level).toBeLessThan(softestPing);
    }
  });
});
