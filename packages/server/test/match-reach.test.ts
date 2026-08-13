/**
 * The ping-reach rings, measured against a running match (`MatchRuntime.pingReach`).
 *
 * `match-reach` in `@seg/shared` proves the two radii invert the propagation model; this proves
 * the *match reaches them* — that a ring appears when a switch is thrown and not before, that both
 * fleets get one, that the inner circle answers to the water round the boat it belongs to and the
 * outer one to the other side's ears, and that a weapon with no hydrophone is honest about having
 * no inner circle. Those are the claims a tester reads the rings for, and none of them is visible
 * in the arithmetic.
 *
 * On a coarse lattice throughout (`MatchRuntimeOptions`), like the field tests beside it.
 */

import {
  deployMatch,
  generateMap,
  getHull,
  getWeapon,
  hullMaterial,
  imagingReach,
  seekerThreshold,
  type BoatTemplate,
  type DeployingPlayer,
  type EntityId,
  type MatchState,
  type PingReachView,
  type Vec2,
  type WeaponId,
} from '@seg/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { MatchRuntime } from '../src/match/runtime.js';

const BOAT: BoatTemplate = { name: 'S-01', hull: 'medium', modules: [] };

function seat(accountId: string, position: DeployingPlayer['position']): DeployingPlayer {
  return { accountId, username: accountId, position, boats: [BOAT] };
}

/** Two boats a long way apart on an empty map, so the water between them is the only variable. */
function match(): MatchState {
  const state = deployMatch({
    matchId: 'm1',
    mode: 'deathmatch',
    map: generateMap('empty', { seed: 11, mapSize: 'small' }),
    startedAt: 0,
    debugMode: true,
    players: [seat('host', 'team1'), seat('foe', 'team2')],
  });
  return {
    ...state,
    boats: state.boats.map((boat) =>
      boat.team === 'team1'
        ? { ...boat, pos: { x: 1000, y: 1000 }, facing: 0 }
        : { ...boat, pos: { x: 3000, y: 1000 }, facing: 180 },
    ),
  };
}

let runtime: MatchRuntime;
let mine: EntityId;
let theirs: EntityId;

function settle(ticks = 4): void {
  for (let i = 0; i < ticks; i += 1) runtime.tick();
}

/** Get a boat genuinely running at flank, and leave it there (`match-fields.test.ts`). */
function underWay(boat: EntityId, to: Vec2): void {
  runtime.setThrottle(boat, 'flank');
  runtime.order(boat, to, false);
  for (let i = 0; i < 80; i += 1) runtime.tick();
}

const ringFor = (id: EntityId): PingReachView | undefined =>
  runtime.pingReach().find((ring) => ring.id === id);

beforeEach(() => {
  runtime = new MatchRuntime(match(), { cellSize: 40, collisionCell: 40 });
  mine = runtime.state.boats.find((boat) => boat.team === 'team1')?.id ?? 0;
  theirs = runtime.state.boats.find((boat) => boat.team === 'team2')?.id ?? 0;
  settle();
});

describe('which transducers get rings', () => {
  it('draws none until a switch is thrown, and one for the boat that threw it', () => {
    expect(runtime.pingReach()).toEqual([]);

    runtime.setActiveSonar('host', mine, true);
    settle();

    const rings = runtime.pingReach();
    expect(rings).toHaveLength(1);
    expect(rings[0]?.id).toBe(mine);
    expect(rings[0]?.team).toBe('team1');
    // True position, which is the whole reason this is its own message rather than a field on the
    // view frame (`protocol/debug.ts`).
    expect(rings[0]?.pos).toEqual(runtime.state.boats.find((b) => b.id === mine)?.pos);
  });

  it('draws the other side’s too, which is what makes it a tool for two fleets', () => {
    runtime.setActiveSonar('host', mine, true);
    runtime.setActiveSonar('foe', theirs, true);
    settle();

    expect(
      runtime
        .pingReach()
        .map((ring) => ring.team)
        .sort(),
    ).toEqual(['team1', 'team2']);
  });

  it('keeps them up between pulses, because they are what a pulse *would* do', () => {
    // A transducer fires every two seconds and rings for four tenths of one, so it is dark for
    // most of the time anybody is watching. Rings that blinked on for eight ticks in forty would
    // be unreadable, and the number they carry does not depend on a pulse being in the water.
    runtime.setActiveSonar('host', mine, true);
    settle(4);
    const firing = ringFor(mine);

    // Well past the pulse's ring-down and short of the next one.
    settle(24);
    const quiet = ringFor(mine);

    expect(firing?.heard ?? 0).toBeGreaterThan(0);
    expect(quiet?.heard).toBeCloseTo(firing?.heard ?? 0, 6);
    expect(quiet?.imaging).toBeCloseTo(firing?.imaging ?? 0, 6);
  });

  it('drops the ring when the switch goes off, and when the boat does', () => {
    runtime.setActiveSonar('host', mine, true);
    settle();
    expect(runtime.pingReach()).toHaveLength(1);

    runtime.setActiveSonar('host', mine, false);
    settle();
    expect(runtime.pingReach()).toEqual([]);

    // A wreck's sonar is off whatever its switch says — there is nobody left to throw it.
    runtime.setActiveSonar('host', mine, true);
    runtime.replace({
      ...runtime.state,
      boats: runtime.state.boats.map((boat) =>
        boat.id === mine ? { ...boat, hp: 0, status: 'destroyed' } : boat,
      ),
    });
    settle();
    expect(runtime.pingReach()).toEqual([]);
  });
});

describe('the radii', () => {
  it('shows far less than it announces', () => {
    // The trade switching the sonar on makes, as one comparison: the pulse tells the other side
    // where you are from several times the range it shows you anything.
    runtime.setActiveSonar('host', mine, true);
    settle();

    const ring = ringFor(mine);
    expect(ring?.imaging ?? 0).toBeGreaterThan(0);
    expect(ring?.heard ?? 0).toBeGreaterThan((ring?.imaging ?? 0) * 2);
  });

  it('pulls the inner circle in when the pinger’s own water gets loud', () => {
    // What "computed from the noise level" means: the inner ring is measured against this boat's
    // own gate, so going to flank — 30 dB of self-noise — costs it imaging while the pulse it
    // would fire is unchanged.
    runtime.setActiveSonar('host', mine, true);
    settle();
    const quiet = ringFor(mine)?.imaging ?? 0;

    underWay(mine, { x: 1600, y: 1000 });
    const loud = ringFor(mine)?.imaging ?? 0;

    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeLessThan(quiet);
  });

  it('pulls the outer circle in when the *other side* stops listening properly', () => {
    // And what makes the outer ring worth its own number rather than a scaled copy of the inner
    // one: it is a fact about the enemy's ears. Nothing about this boat changes here.
    runtime.setActiveSonar('host', mine, true);
    settle();
    const listening = ringFor(mine)?.heard ?? 0;

    underWay(theirs, { x: 2400, y: 1000 });
    const deafened = ringFor(mine)?.heard ?? 0;

    expect(listening).toBeGreaterThan(0);
    expect(deafened).toBeLessThan(listening);
    // The inner ring moves as well, and it is worth being clear that this is not the same effect
    // leaking across: a boat at flank a kilometre away raises the *background* here, which is a
    // fact about this boat's own water. Two rings, two reasons, one noisy opponent.
  });
});

describe('weapons', () => {
  /** Put a weapon of `weapon` in the water with its seeker awake. */
  function armed(weapon: WeaponId, at: Vec2): EntityId {
    runtime.spawnTorpedo('host', weapon, 'team1', at);
    const spawned = runtime.state.torpedoes[runtime.state.torpedoes.length - 1];
    if (spawned === undefined) throw new Error('no weapon');
    runtime.replace({
      ...runtime.state,
      torpedoes: runtime.state.torpedoes.map((torpedo) =>
        torpedo.id === spawned.id ? { ...torpedo, phase: 'enabled' } : torpedo,
      ),
    });
    settle();
    return spawned.id;
  }

  it('rings a seeker with the range its homing actually works at', () => {
    const id = armed('standard', { x: 1400, y: 1000 });

    const ring = ringFor(id);
    expect(ring?.team).toBe('team1');
    expect(ring?.heard ?? 0).toBeGreaterThan(0);
    // The seeker is a receiver — that is what its homing is made of — so the inner circle is the
    // range it would acquire a hull from, measured with `seekerEcho`'s own two terms.
    const acquires = imagingReach(
      getWeapon('standard').seekerPingLevel,
      seekerThreshold(),
      hullMaterial(getHull('medium').stats).absorption,
    );
    expect(ring?.imaging).toBeCloseTo(acquires, 6);
    // And far shorter than the range the same weapon announces itself from, which is the whole
    // reason an enable point set too early is a bad shot.
    expect(ring?.heard ?? 0).toBeGreaterThan((ring?.imaging ?? 0) * 2);
  });

  it('reaches further when there is a more reflective hull to find', () => {
    // A seeker's reach is a fact about what it is looking at, so the envelope follows the loudest
    // reflector in the water — a Heavy, or anything wearing a Heavy's stat block.
    const id = armed('standard', { x: 1400, y: 1000 });
    const against = ringFor(id)?.imaging ?? 0;

    runtime.spawnBoat('host', 'heavy', 'team2', { x: 2200, y: 1000 });
    settle();

    expect(ringFor(id)?.imaging ?? 0).toBeGreaterThan(against);
  });

  it('reads the drone’s inner circle off rock, because the drone hears through the solve', () => {
    // The other receiver, on the one weapon that carries it: a drone is a listener in the solve
    // like a boat, so its pulse is measured against the water round it rather than against a hull.
    const id = armed('drone', { x: 1400, y: 1000 });

    const ring = ringFor(id);
    expect(ring?.imaging ?? 0).toBeGreaterThan(0);
    // Not the seeker's answer: a drone does not home, and nothing about a hull's absorption is in
    // this number (`sim/weapons/phase.ts#look` — only a `seeker` load acts on what came back).
    expect(ring?.imaging).not.toBeCloseTo(
      imagingReach(
        getWeapon('drone').seekerPingLevel,
        seekerThreshold(),
        hullMaterial(getHull('medium').stats).absorption,
      ),
      0,
    );
    // Louder than any hull's pulse and better ears than any hull carries, so it out-reaches the
    // submarine beside it on both counts.
    runtime.setActiveSonar('host', mine, true);
    settle();
    const boat = ringFor(mine);
    expect(ring?.heard ?? 0).toBeGreaterThan(boat?.heard ?? 0);
  });

  it('says nothing about a weapon that has not armed, or a load with no transducer', () => {
    runtime.spawnTorpedo('host', 'standard', 'team1', { x: 1400, y: 1000 });
    settle();
    // Still in its launch phase: the transducer is carried, not switched on.
    expect(runtime.pingReach()).toEqual([]);

    // And a load that carries no transducer at all never had one to switch on.
    armed('active-decoy', { x: 1600, y: 1000 });
    expect(runtime.pingReach()).toEqual([]);
  });
});
