/**
 * Being pinged (`sim/acoustics/pings.ts`).
 *
 * The claim these defend is the one the mechanic is sold on: **you cannot ping anybody without
 * telling them where you are**. A pulse is heard on a one-way path, where finding anything with it
 * costs the path twice, so the range at which it gives its owner away is far past the range at
 * which it shows its owner anything. If that ever stops being true, active sonar has stopped being
 * a trade and these are the tests that should have to change.
 *
 * The arithmetic itself is deliberately built out of `transmissionLoss`, `noiseFloorOf` and
 * `returnThreshold` rather than out of numbers of its own, so what is pinned here is the *shape* —
 * which things pulse, who hears them, and how the two ranges compare — and not a decibel table
 * that is expected to move under the balance harness.
 */

import { describe, expect, it } from 'vitest';

import {
  ACOUSTICS,
  boatListener,
  boatPulse,
  classificationThreshold,
  deployMatch,
  generateMap,
  getWeapon,
  pulseExcessAt,
  pulseHeardBy,
  seekerEcho,
  seekerPulse,
  TerrainCollider,
  torpedoListener,
  type BoatState,
  type BoatTemplate,
  type MatchState,
  type TorpedoState,
  type Vec2,
} from '../src/index.js';

const LIGHT: BoatTemplate = { name: 'S-01', hull: 'light', modules: [] };
const HEAVY: BoatTemplate = { name: 'S-02', hull: 'heavy', modules: [] };

/**
 * Two deployed boats, one per side, so the states under test are ones the game produces.
 *
 * Deployed once and reused: generating a map and placing a fleet is most of a second, and every
 * fixture below is a copy of one of these two with a position and a flag changed.
 */
let deployed: MatchState | null = null;
function fleet(): MatchState {
  deployed ??= deployMatch({
    matchId: 'm1',
    mode: 'deathmatch',
    map: generateMap('empty', { seed: 5, mapSize: 'small' }),
    startedAt: 0,
    players: [
      { accountId: 'a', username: 'a', position: 'team1', boats: [HEAVY] },
      { accountId: 'b', username: 'b', position: 'team2', boats: [LIGHT] },
    ],
  });
  return deployed;
}

function boatOf(team: 'team1' | 'team2', at: Vec2, changes: Partial<BoatState> = {}): BoatState {
  const found = fleet().boats.find((boat) => boat.team === team);
  if (found === undefined) throw new Error('deployment produced no boat');
  return { ...found, pos: at, ...changes };
}

/** A pinging boat: switch on, and a pulse fired on tick 40. */
function pinger(at: Vec2, changes: Partial<BoatState> = {}): BoatState {
  return boatOf('team1', at, { activeSonar: true, lastPingTick: 40, ...changes });
}

function listenerAt(at: Vec2, changes: Partial<BoatState> = {}) {
  const listener = boatListener(boatOf('team2', at, changes));
  if (listener === null) throw new Error('a live boat has ears');
  return listener;
}

/** One weapon in the water, in whatever phase the test wants. */
function weapon(changes: Partial<TorpedoState> = {}): TorpedoState {
  return {
    id: 900,
    team: 'team1',
    firedBy: 1,
    weapon: 'standard',
    pos: { x: 1000, y: 500 },
    facing: 0,
    speed: 55,
    phase: 'enabled',
    firedTick: 0,
    enabledTick: 10,
    lastPingTick: 40,
    trackTick: 0,
    aim: { x: 2000, y: 500 },
    track: null,
    mimic: null,
    transients: [],
    ...changes,
  } as TorpedoState;
}

describe('what counts as a pulse', () => {
  it('is a boat whose transducer fired inside the window', () => {
    expect(boatPulse(pinger({ x: 1000, y: 500 }), 39)).toEqual({
      at: { x: 1000, y: 500 },
      level: 124,
      tick: 40,
    });
  });

  it('is not a pulse from before the window — that one has already been reported', () => {
    expect(boatPulse(pinger({ x: 1000, y: 500 }), 41)).toBeNull();
  });

  /*
   * Zero is *never pulsed* rather than "pulsed at tick zero" — the distinction `pingLevelOf`
   * draws. A fixture whose switch starts on has not yet told anybody anything.
   */
  it('is not a boat with the switch on that has never fired', () => {
    expect(boatPulse(pinger({ x: 1000, y: 500 }, { lastPingTick: 0 }), 0)).toBeNull();
  });

  it('is not a boat with the switch off, and not a wreck', () => {
    expect(boatPulse(pinger({ x: 1000, y: 500 }, { activeSonar: false }), 39)).toBeNull();
    expect(boatPulse(pinger({ x: 1000, y: 500 }, { status: 'destroyed' }), 39)).toBeNull();
  });

  it('is a weapon’s seeker, once it has enabled and while it still runs', () => {
    expect(seekerPulse(weapon(), 39)?.level).toBe(getWeapon('standard').seekerPingLevel);
    expect(seekerPulse(weapon({ phase: 'run' }), 39)).toBeNull();
    expect(seekerPulse(weapon({ phase: 'spent' }), 39)).toBeNull();
  });

  /* A decoy and a super-cavitating torpedo have no transducer, so there is nothing to hear. */
  it('is not a weapon that carries no transducer', () => {
    expect(seekerPulse(weapon({ weapon: 'super-cavitating' }), 39)).toBeNull();
    expect(seekerPulse(weapon({ weapon: 'active-decoy' }), 39)).toBeNull();
  });
});

describe('who hears one', () => {
  it('is every live boat, and no wreck', () => {
    expect(boatListener(boatOf('team2', { x: 0, y: 0 }))).not.toBeNull();
    expect(boatListener(boatOf('team2', { x: 0, y: 0 }, { status: 'destroyed' }))).toBeNull();
  });

  /*
   * The drone, and only the drone. It is the one load with a hydrophone, which is the whole of
   * why it costs a tube and twenty points (`content/weapons.ts#WeaponHydrophone`) — and a weapon
   * that hears on behalf of its team hears a pulse aimed at that team too.
   */
  it('is a drone in the water, and no other weapon', () => {
    expect(torpedoListener(weapon({ weapon: 'drone' }))).not.toBeNull();
    expect(torpedoListener(weapon({ weapon: 'drone', phase: 'spent' }))).toBeNull();
    expect(torpedoListener(weapon())).toBeNull();
  });
});

describe('a pulse arriving', () => {
  it('lights a boat two kilometres off far above the bar', () => {
    const excess = pulseExcessAt(
      boatPulse(pinger({ x: 1000, y: 500 }), 39) ?? { at: { x: 0, y: 0 }, level: 0, tick: 0 },
      listenerAt({ x: 3000, y: 500 }),
    );
    expect(excess).toBeGreaterThan(ACOUSTICS.confirmationThreshold);
  });

  it('falls off with range, and stops being reportable well before it stops existing', () => {
    const pulse = boatPulse(pinger({ x: 1000, y: 500 }), 39);
    if (pulse === null) throw new Error('the fixture pulsed');

    const near = pulseExcessAt(pulse, listenerAt({ x: 2000, y: 500 }));
    const far = pulseExcessAt(pulse, listenerAt({ x: 4000, y: 500 }));
    expect(far).toBeLessThan(near);

    // The deployment bands are the far end of the scale: a boat pinging from its own start
    // position tells the other side's start position nothing at all.
    expect(pulseHeardBy(pulse, listenerAt({ x: 7200, y: 500 }), null)).toBe(false);
  });

  /*
   * The trade the switch exists for. A pulse is heard on a **one-way** path and finds things on a
   * two-way one, so the range at which it gives its owner away is far past the range at which it
   * measures anything — compared here against the echo that strips a decoy, which is the same
   * pulse from the same boat doing the job it was fired for.
   */
  it('is heard from very much further than it can see', () => {
    const boat = pinger({ x: 1000, y: 500 });
    const pulse = boatPulse(boat, 39);
    if (pulse === null) throw new Error('the fixture pulsed');

    const target = boatOf('team2', { x: 0, y: 0 });
    const measures = (range: number): boolean =>
      seekerEcho(boat.stats.pingLevel, range, target.stats) >= classificationThreshold(boat);
    const isHeard = (range: number): boolean =>
      pulseHeardBy(pulse, listenerAt({ x: 1000 + range, y: 500 }), null);

    // The furthest the pulse still measures the hull it is aimed at. Both are true there.
    let seeing = 100;
    while (seeing < 4000 && measures(seeing + 100)) seeing += 100;
    expect(measures(seeing)).toBe(true);
    expect(isHeard(seeing)).toBe(true);

    // And well past it, where the target hears the pulse perfectly and the pinger has learned
    // nothing at all about the boat that just heard it.
    expect(measures(seeing * 3)).toBe(false);
    expect(isHeard(seeing * 3)).toBe(true);
  });

  it('is harder to place from a boat running fast, which is deafer to everything', () => {
    const pulse = boatPulse(pinger({ x: 1000, y: 500 }), 39);
    if (pulse === null) throw new Error('the fixture pulsed');

    const stopped = pulseExcessAt(pulse, listenerAt({ x: 3000, y: 500 }, { speed: 0 }));
    const running = pulseExcessAt(pulse, listenerAt({ x: 3000, y: 500 }, { speed: 15 }));
    expect(running).toBeLessThan(stopped);
  });

  it('cannot be traced round a corner', () => {
    // A dense map, and a pair of positions with rock between them — found rather than assumed,
    // because where the walls fall is the generator's business.
    const map = generateMap('dense', { seed: 11, mapSize: 'small' });
    const terrain = new TerrainCollider(map.extents, map.terrain.obstacles);

    // A wall with open water on both sides of it, found rather than assumed — where the rock
    // falls is the generator's business.
    let pair: { readonly from: Vec2; readonly to: Vec2 } | null = null;
    const gap = 200;
    for (let x = gap; x < map.extents.width - gap && pair === null; x += 20) {
      for (let y = gap; y < map.extents.height - gap; y += 20) {
        if (!terrain.isRock(x, y)) continue;
        const from = { x: x - gap, y };
        const to = { x: x + gap, y };
        if (terrain.isRock(from.x, from.y) || terrain.isRock(to.x, to.y)) continue;
        pair = { from, to };
        break;
      }
    }
    if (pair === null) throw new Error('a dense map has a wall with water on both sides of it');

    const pulse = boatPulse(pinger(pair.from), 39);
    if (pulse === null) throw new Error('the fixture pulsed');
    const listener = listenerAt(pair.to);

    // Four hundred metres apart is deafeningly loud — and it is heard only if the sound has water
    // to travel through.
    expect(pulseHeardBy(pulse, listener, null)).toBe(true);
    expect(pulseHeardBy(pulse, listener, terrain)).toBe(false);
  });
});
