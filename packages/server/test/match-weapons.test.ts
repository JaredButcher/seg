/**
 * Firing, from the runtime's side.
 *
 * `weapons-phase` proves what a weapon does once it is in the water; this proves the runtime
 * puts it there — that ownership is checked where the boats are, that a salvo leaves as a salvo,
 * that a torpedo reaches the acoustic solve as an ordinary noisy entity, and that a hostile
 * launch is heard only when the boat that fired it was already audible.
 *
 * On an **empty** map unless a test needs rock, and with the fleets pulled close together. The
 * deployment bands sit at opposite ends of the world by design, which is right for a match and
 * useless for a test about whether a weapon can reach a boat.
 */

import {
  deployMatch,
  generateMap,
  getWeapon,
  SIM_TICK_HZ,
  viewFor,
  type BoatTemplate,
  type DeployingPlayer,
  type MatchState,
  type TorpedoState,
  type Vec2,
  type WeaponId,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

import { MatchRuntime } from '../src/match/runtime.js';

const LIGHT: BoatTemplate = { name: 'S-01', hull: 'light', modules: [] };
const MEDIUM: BoatTemplate = { name: 'S-02', hull: 'medium', modules: [] };

function player(
  accountId: string,
  position: DeployingPlayer['position'],
  boats: readonly BoatTemplate[] = [],
): DeployingPlayer {
  return { accountId, username: accountId, position, boats };
}

function match(mapType: 'empty' | 'dense' = 'empty'): MatchState {
  return deployMatch({
    matchId: 'm1',
    mode: 'deathmatch',
    map: generateMap(mapType, { seed: 11, mapSize: 'small' }),
    startedAt: 0,
    players: [
      player('host', 'team1', [MEDIUM]),
      player('foe', 'team2', [LIGHT]),
      player('watcher', 'spectator'),
    ],
  });
}

/**
 * Move both boats where the test wants them, facing each other.
 *
 * Bypasses movement deliberately: these tests are about weapons, and driving two boats across a
 * map first would make every one of them depend on the transit phase as well.
 */
function place(state: MatchState, host: Vec2, foe: Vec2): MatchState {
  return {
    ...state,
    boats: state.boats.map((boat) =>
      boat.team === 'team1'
        ? { ...boat, pos: host, facing: 0 }
        : { ...boat, pos: foe, facing: 180 },
    ),
  };
}

function hostBoat(runtime: MatchRuntime) {
  const boat = runtime.state.boats.find((candidate) => candidate.team === 'team1');
  if (boat === undefined) throw new Error('no host boat');
  return boat;
}

describe('firing', () => {
  it('puts a weapon in the water, mints it a fresh id, and starts the tube reloading', () => {
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);
    const before = runtime.state.nextEntityId;

    expect(runtime.fire('host', boat.id, [0], { x: 2000, y: 500 })).toBe(1);

    const [weapon] = runtime.state.torpedoes;
    expect(weapon?.id).toBe(before);
    expect(runtime.state.nextEntityId).toBe(before + 1);
    expect(weapon?.team).toBe('team1');
    expect(weapon?.firedBy).toBe(boat.id);
    expect(weapon?.aim).toEqual({ x: 2000, y: 500 });

    const after = hostBoat(runtime);
    expect(after.tubes[0]?.status).toBe('reloading');
    expect(after.transients.some((t) => t.kind === 'torpedo-launch')).toBe(true);
  });

  it('fires the first tube that can when none are named', () => {
    // The bare ctrl-click with nothing sub-selected, and the shot most players will take.
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);

    expect(runtime.fire('host', boat.id, [], { x: 2000, y: 500 })).toBe(1);
    expect(hostBoat(runtime).tubes[0]?.status).toBe('reloading');
    expect(hostBoat(runtime).tubes[1]?.status).toBe('loaded');
  });

  it('fires a salvo as a salvo, threading each launch through the last', () => {
    // Every tube ends up reloading. Accumulating the launches instead of threading them would
    // leave only the last write standing, which is a bug that looks like a UI problem.
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);
    const tubes = boat.tubes.map((tube) => tube.index);

    expect(runtime.fire('host', boat.id, tubes, { x: 2000, y: 500 })).toBe(tubes.length);
    expect(runtime.state.torpedoes).toHaveLength(tubes.length);
    expect(hostBoat(runtime).tubes.every((tube) => tube.status === 'reloading')).toBe(true);
    // Distinct ids, or the second weapon would be indistinguishable from the first everywhere
    // downstream — in the picture, in the audio, and in the contact book.
    expect(new Set(runtime.state.torpedoes.map((t) => t.id)).size).toBe(tubes.length);
  });

  it('fires only the tubes that can, and says how many went', () => {
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);
    runtime.fire('host', boat.id, [0], { x: 2000, y: 500 });

    // Tube 0 is now reloading; asking for both gets one.
    expect(runtime.fire('host', boat.id, [0, 1], { x: 2000, y: 500 })).toBe(1);
    expect(runtime.state.torpedoes).toHaveLength(2);
  });

  it('refuses a boat the account does not command, and a wreck', () => {
    // The ownership check lives beside the boats rather than in the handler, so a second caller
    // cannot route around it (planning/01 §5).
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);

    expect(runtime.fire('foe', boat.id, [0], { x: 2000, y: 500 })).toBe(0);
    expect(runtime.fire('watcher', boat.id, [0], { x: 2000, y: 500 })).toBe(0);
    expect(runtime.state.torpedoes).toHaveLength(0);

    runtime.replace({
      ...runtime.state,
      boats: runtime.state.boats.map((candidate) =>
        candidate.id === boat.id ? { ...candidate, status: 'destroyed', hp: 0 } : candidate,
      ),
    });
    expect(runtime.fire('host', boat.id, [0], { x: 2000, y: 500 })).toBe(0);
  });

  it('ignores a tube index that does not exist, and a repeated one', () => {
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);
    // A crafted message. Two copies of tube 0 must not fire it twice.
    expect(runtime.fire('host', boat.id, [0, 0, 99], { x: 2000, y: 500 })).toBe(1);
  });
});

describe('loading', () => {
  it('queues the next load without touching the tube now', () => {
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);

    expect(runtime.load('host', boat.id, 0, 'super-cavitating', false)).toBe(true);
    expect(hostBoat(runtime).tubes[0]?.status).toBe('loaded');
    expect(hostBoat(runtime).tubes[0]?.weapon).toBe('standard');
    expect(hostBoat(runtime).tubes[0]?.next).toBe('super-cavitating');

    // And it is what comes back after the shot.
    runtime.fire('host', boat.id, [0], { x: 2000, y: 500 });
    expect(hostBoat(runtime).tubes[0]?.weapon).toBe('super-cavitating');
  });

  it('empties the tube first when the swap flag is set', () => {
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);

    expect(runtime.load('host', boat.id, 0, 'super-cavitating', true)).toBe(true);
    expect(hostBoat(runtime).tubes[0]?.status).toBe('unloading');
  });

  it('refuses a load the weapons phase cannot deploy', () => {
    // The picker offers only deployable loads, and this is the second copy of that rule: the
    // client checks so the player is told instantly, the server checks because the client is not
    // trusted. A tube quietly holding an unbuilt mine would be a tube the player has disarmed.
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);
    expect(runtime.load('host', boat.id, 0, 'mine', false)).toBe(false);
    expect(hostBoat(runtime).tubes[0]?.next).toBe('standard');
  });

  it('refuses a boat the account does not command, and a tube that is not there', () => {
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);
    expect(runtime.load('foe', boat.id, 0, 'super-cavitating', false)).toBe(false);
    expect(runtime.load('host', boat.id, 99, 'super-cavitating', false)).toBe(false);
  });
});

describe('a weapon in the world', () => {
  it('travels, and reaches the firing team’s view frame but not the enemy’s', () => {
    // A friendly weapon is the team's to see; a hostile one arrives the way every hostile thing
    // does, through the sonar picture.
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);
    runtime.fire('host', boat.id, [0], { x: boat.pos.x + 900, y: boat.pos.y });

    const start = runtime.state.torpedoes[0]?.pos.x ?? 0;
    for (let i = 0; i < 20; i += 1) runtime.tick();

    expect(runtime.state.torpedoes[0]?.pos.x).toBeGreaterThan(start);
    expect(viewFor(runtime.state, 'host').torpedoes).toHaveLength(1);
    expect(viewFor(runtime.state, 'foe').torpedoes).toHaveLength(0);
    // A spectator has no team, so no weapons either — the same rule as their empty fleet.
    expect(viewFor(runtime.state, 'watcher').torpedoes).toHaveLength(0);
  });

  it('arms at the aim point and starts pinging', () => {
    const runtime = new MatchRuntime(place(match(), { x: 1500, y: 500 }, { x: 2400, y: 500 }));
    const boat = hostBoat(runtime);
    // Close enough that the run-out is a couple of hundred metres.
    runtime.fire('host', boat.id, [0], { x: 1900, y: 500 });

    for (let i = 0; i < 20 * SIM_TICK_HZ; i += 1) {
      runtime.tick();
      const weapon = runtime.state.torpedoes[0];
      if (weapon !== undefined && weapon.lastPingTick > 0) break;
    }

    const weapon = runtime.state.torpedoes[0];
    expect(weapon?.phase).not.toBe('running');
    expect(weapon?.lastPingTick).toBeGreaterThan(0);
  });

  it('kills a boat it reaches, and the standings follow the fleet', () => {
    // The standings are derived rather than incremented (`match/state.ts`), so a destroyed boat
    // cannot leave a scoreboard that disagrees with the water.
    const runtime = new MatchRuntime(place(match(), { x: 1500, y: 500 }, { x: 1900, y: 500 }));
    const boat = hostBoat(runtime);
    const target = runtime.state.boats.find((candidate) => candidate.team === 'team2');
    // Enable well short, so the seeker has the run in front of it.
    runtime.fire('host', boat.id, [0], { x: 1700, y: 500 });

    for (let i = 0; i < 60 * SIM_TICK_HZ; i += 1) {
      runtime.tick();
      const hit = runtime.state.boats.find((candidate) => candidate.id === target?.id);
      if (hit !== undefined && hit.hp < (target?.hp ?? 0)) break;
    }

    const hit = runtime.state.boats.find((candidate) => candidate.id === target?.id);
    expect(hit?.hp).toBeLessThan(target?.hp ?? 0);
    expect(runtime.state.teams.team2.survivingPoints).toBeLessThan(
      runtime.state.teams.team1.survivingPoints,
    );
  });

  it('is audible: it reaches the solve as an ordinary entity and lights the enemy’s picture', () => {
    // planning/04 §4's uniform entity model, cashed in. Nothing in the solver knows what a
    // torpedo is; it is loud, so it appears.
    const runtime = new MatchRuntime(place(match(), { x: 1500, y: 500 }, { x: 1900, y: 500 }));
    const boat = hostBoat(runtime);
    // A super-cavitating weapon at 92 dB, which is the loudest continuous thing in the game.
    runtime.load('host', boat.id, 0, 'super-cavitating', true);
    for (let i = 0; i < 40 * SIM_TICK_HZ; i += 1) {
      if (hostBoat(runtime).tubes[0]?.status === 'loaded') break;
      runtime.tick();
    }
    runtime.fire('host', boat.id, [0], { x: 1700, y: 500 });

    const weaponId = runtime.state.torpedoes[0]?.id;
    let seen = false;
    for (let i = 0; i < 4 * SIM_TICK_HZ && !seen; i += 1) {
      if (!runtime.tick()) continue;
      const frame = runtime.visionFor('foe', 'team2');
      seen = frame?.contacts.some((contact) => contact.kind === 'torpedo') ?? false;
    }

    expect(weaponId).toBeDefined();
    expect(seen).toBe(true);
  });
});

describe('the launch alarm', () => {
  it('reaches a team that was already hearing the boat that fired', () => {
    // Not a rule of its own: the launch transient is 85 dB, so it lights the firer's own hull
    // squares, and "did we hear the shot" is answered by the ordinary detection machinery.
    const runtime = new MatchRuntime(place(match(), { x: 1500, y: 500 }, { x: 1800, y: 500 }));
    const boat = hostBoat(runtime);
    runtime.fire('host', boat.id, [0], { x: 2400, y: 500 });

    let heard = false;
    for (let i = 0; i < 2 * SIM_TICK_HZ && !heard; i += 1) {
      if (!runtime.tick()) continue;
      heard = (runtime.visionFor('foe', 'team2')?.launches.length ?? 0) > 0;
    }
    expect(heard).toBe(true);
  });

  it('does not reach the team that fired — you know you fired', () => {
    const runtime = new MatchRuntime(place(match(), { x: 1500, y: 500 }, { x: 1800, y: 500 }));
    const boat = hostBoat(runtime);
    runtime.fire('host', boat.id, [0], { x: 2400, y: 500 });

    for (let i = 0; i < 2 * SIM_TICK_HZ; i += 1) {
      if (!runtime.tick()) continue;
      expect(runtime.visionFor('host', 'team1')?.launches ?? []).toHaveLength(0);
    }
  });

  it('does not reach a team on the far side of the map, which is why you shoot from out there', () => {
    // The default deployment bands, four thousand metres apart on a small map. A boat that fires
    // from outside detection range fires unannounced.
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);
    runtime.fire('host', boat.id, [0], { x: boat.pos.x + 900, y: boat.pos.y });

    let heard = false;
    for (let i = 0; i < 2 * SIM_TICK_HZ && !heard; i += 1) {
      if (!runtime.tick()) continue;
      heard = (runtime.visionFor('foe', 'team2')?.launches.length ?? 0) > 0;
    }
    expect(heard).toBe(false);
  });

  it('reports one launch once, however many frames repeat it', () => {
    // The frame carries an alert for a few seconds so a dropped packet cannot delete it
    // (`match/vision.ts#LAUNCH_ALERT_SECONDS`), which means the same tick must not accumulate.
    const runtime = new MatchRuntime(place(match(), { x: 1500, y: 500 }, { x: 1800, y: 500 }));
    const boat = hostBoat(runtime);
    runtime.fire('host', boat.id, [0], { x: 2400, y: 500 });

    const ticks = new Set<number>();
    for (let i = 0; i < 3 * SIM_TICK_HZ; i += 1) {
      if (!runtime.tick()) continue;
      for (const launch of runtime.visionFor('foe', 'team2')?.launches ?? []) {
        ticks.add(launch.tick);
      }
    }
    expect(ticks.size).toBe(1);
  });

  it('ages out, so the alert does not sit on the wire for the rest of the match', () => {
    const runtime = new MatchRuntime(place(match(), { x: 1500, y: 500 }, { x: 1800, y: 500 }));
    const boat = hostBoat(runtime);
    runtime.fire('host', boat.id, [0], { x: 2400, y: 500 });

    // Well past `LAUNCH_ALERT_SECONDS`, and past the reload so nothing fires again.
    let last: number | undefined;
    for (let i = 0; i < 8 * SIM_TICK_HZ; i += 1) {
      if (!runtime.tick()) continue;
      last = runtime.visionFor('foe', 'team2')?.launches.length;
    }
    expect(last).toBe(0);
  });
});

describe('the content table', () => {
  it('pairs the two loads the way the design does', () => {
    // A guard on the numbers rather than a test of behaviour: the whole shape of the pair is
    // that one is fast and blind and the other is slow and can hunt, and a rebalance that
    // quietly gave the sprinter a seeker would delete the other's reason to exist.
    const standard = getWeapon('standard');
    const scv = getWeapon('super-cavitating');

    expect(scv.speed).toBeGreaterThan(standard.speed * 2);
    expect(scv.maxPitch).toBeLessThan(standard.maxPitch);
    expect(scv.seekerPingLevel).toBe(0);
    expect(standard.seekerPingLevel).toBeGreaterThan(0);
    // Fast is loud. The price of the speed, and how a target gets a chance to be elsewhere.
    expect(scv.sourceLevel).toBeGreaterThan(standard.sourceLevel);
    expect(standard.deployable && scv.deployable).toBe(true);
  });
});

/**
 * Put a weapon in the water without firing it.
 *
 * The two utility loads are slow and long-lived by design — a drone takes three minutes to reach
 * anywhere worth loitering — and a test that drove one there would be a test about transit times.
 * What is being proved here is what a weapon on station *does*, so it is placed on station.
 */
function inject(
  runtime: MatchRuntime,
  weapon: WeaponId,
  at: Vec2,
  overrides: Partial<TorpedoState> = {},
): TorpedoState {
  const state = runtime.state;
  const firer = state.boats.find((boat) => boat.team === 'team1');
  if (firer === undefined) throw new Error('no host boat');

  const torpedo: TorpedoState = {
    id: state.nextEntityId,
    weapon,
    team: 'team1',
    owner: 'host',
    firedBy: firer.id,
    firedTick: state.clock.tick,
    aim: at,
    mimic:
      getWeapon(weapon).behaviour === 'decoy' ? { hull: firer.hull, stats: firer.stats } : null,
    pos: at,
    facing: 0,
    speed: 0,
    travelled: 0,
    phase: 'enabled',
    track: null,
    trackTick: 0,
    lastPingTick: 0,
    transients: [],
    ...overrides,
  };

  runtime.replace({
    ...state,
    torpedoes: [...state.torpedoes, torpedo],
    nextEntityId: state.nextEntityId + 1,
  });
  return torpedo;
}

function foeBoat(runtime: MatchRuntime) {
  const boat = runtime.state.boats.find((candidate) => candidate.team === 'team2');
  if (boat === undefined) throw new Error('no foe boat');
  return boat;
}

/** Tick until `until` says so, or give up. Returns whether it ever did. */
function until(runtime: MatchRuntime, seconds: number, ready: () => boolean): boolean {
  for (let i = 0; i < seconds * SIM_TICK_HZ; i += 1) {
    runtime.tick();
    if (ready()) return true;
  }
  return false;
}

describe('the drone', () => {
  /*
   * The fleets are at their deployment bands, four kilometres apart, so neither team can hear the
   * other at all. That is the control: anything team1 learns about the enemy in these tests, it
   * learned from the drone.
   */
  const boatContacts = (runtime: MatchRuntime) =>
    (runtime.visionFor('host', 'team1')?.contacts ?? []).filter(
      (contact) => contact.kind === 'boat',
    );

  it('charts an enemy its own fleet is far too far away to hear', () => {
    const runtime = new MatchRuntime(match());
    const foe = foeBoat(runtime);
    // Deaf on its own account first — the whole test rests on this being true.
    expect(until(runtime, 4, () => boatContacts(runtime).length > 0)).toBe(false);

    inject(runtime, 'drone', { x: foe.pos.x - 250, y: foe.pos.y });
    expect(until(runtime, 20, () => boatContacts(runtime).length > 0)).toBe(true);

    // And it is the enemy boat, at roughly where the enemy boat is, rather than the team's own
    // weapon appearing in its own picture.
    const [contact] = boatContacts(runtime);
    expect(contact?.hull).toBe(foe.hull);
    expect(Math.abs((contact?.pos.x ?? 0) - foe.pos.x)).toBeLessThan(50);
  });

  it('is the loudest thing on the map while it works, and the enemy sees it for what it is', () => {
    // The price of the drone, and it is not subtle: 126 dB every two seconds, from a fixed point.
    const runtime = new MatchRuntime(match());
    const foe = foeBoat(runtime);
    inject(runtime, 'drone', { x: foe.pos.x - 250, y: foe.pos.y });

    const seen = until(runtime, 20, () =>
      (runtime.visionFor('foe', 'team2')?.contacts ?? []).some(
        (contact) => contact.kind === 'torpedo',
      ),
    );
    expect(seen).toBe(true);
  });
});

describe('the active decoy', () => {
  const contacts = (runtime: MatchRuntime) => runtime.visionFor('foe', 'team2')?.contacts ?? [];

  it('confirms to the enemy as the submarine that fired it, silhouette and all', () => {
    // Not a flag on a torpedo: the decoy reaches the solve as that boat, so the squares that
    // confirm it really are a submarine-sized reflector radiating a submarine's noise.
    const runtime = new MatchRuntime(match());
    const foe = foeBoat(runtime);
    const host = hostBoat(runtime);
    inject(runtime, 'active-decoy', { x: foe.pos.x - 300, y: foe.pos.y }, { speed: 8 });

    expect(until(runtime, 20, () => contacts(runtime).length > 0)).toBe(true);
    const [contact] = contacts(runtime);
    expect(contact?.kind).toBe('boat');
    expect(contact?.hull).toBe(host.hull);
  });

  it('is stripped by an active pulse, and the same contact turns into a torpedo', () => {
    // The one counter, and what it costs to use it. The contact keeps its id — the player watches
    // the silhouette they were chasing become a dart, rather than a second mark appearing beside
    // it (`match/vision.ts#ContactBook`).
    const runtime = new MatchRuntime(match());
    const foe = foeBoat(runtime);
    inject(runtime, 'active-decoy', { x: foe.pos.x - 300, y: foe.pos.y }, { speed: 8 });

    expect(until(runtime, 20, () => contacts(runtime).length > 0)).toBe(true);
    const fooled = contacts(runtime)[0];
    expect(fooled?.kind).toBe('boat');

    runtime.setActiveSonar('foe', foe.id, true);
    const stripped = until(runtime, 10, () => contacts(runtime)[0]?.kind === 'torpedo');

    expect(stripped).toBe(true);
    expect(contacts(runtime)[0]?.id).toBe(fooled?.id);
  });

  it('stays a boat to the team that has not pinged it', () => {
    // Classification is a thing one crew worked out. Team1's own decoy is not a contact at all,
    // and a second enemy team would still be fooled — which is why the record is per team.
    const runtime = new MatchRuntime(match());
    const foe = foeBoat(runtime);
    inject(runtime, 'active-decoy', { x: foe.pos.x - 300, y: foe.pos.y }, { speed: 8 });

    expect(until(runtime, 20, () => contacts(runtime).length > 0)).toBe(true);
    expect(runtime.visionFor('host', 'team1')?.contacts ?? []).toHaveLength(0);
  });
});
