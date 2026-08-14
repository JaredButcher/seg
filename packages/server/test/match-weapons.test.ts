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
  DEPLOYABLE_WEAPON_IDS,
  generateMap,
  getWeapon,
  SIM_TICK_HZ,
  turningRadius,
  viewFor,
  WEAPON_IDS,
  type BoatState,
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
    expect(hostBoat(runtime).tubes[0]?.weapon).toBe('active-torpedo');
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
    expect(hostBoat(runtime).tubes[0]?.next).toBe('active-torpedo');
  });

  it('refuses a boat the account does not command, and a tube that is not there', () => {
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);
    expect(runtime.load('foe', boat.id, 0, 'super-cavitating', false)).toBe(false);
    expect(runtime.load('host', boat.id, 99, 'super-cavitating', false)).toBe(false);
  });

  it('refuses a countermeasure, which is deployable and still not a tube load', () => {
    // The other half of `isTubeWeapon`, and the half that is not about unbuilt weapons: a
    // noisemaker goes in the water perfectly well, from a launcher every boat already has
    // (`match/world.ts#CountermeasureState`). A tube holding one would have cost the boat a
    // torpedo for something it was never short of.
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);
    expect(runtime.load('host', boat.id, 0, 'noisemaker', false)).toBe(false);
    expect(hostBoat(runtime).tubes[0]?.next).toBe('active-torpedo');
  });
});

describe('dropping a countermeasure', () => {
  it('puts one under the boat, mints it an id, and starts the launcher reloading', () => {
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);
    const before = runtime.state.nextEntityId;

    expect(runtime.drop('host', boat.id)).toBe(true);

    const [made] = runtime.state.torpedoes;
    expect(made?.id).toBe(before);
    expect(runtime.state.nextEntityId).toBe(before + 1);
    expect(made?.weapon).toBe('noisemaker');
    expect(made?.team).toBe('team1');
    expect(made?.firedBy).toBe(boat.id);
    // Under the hull, on its way down, and already doing the only thing it does.
    expect(made?.pos.x).toBe(boat.pos.x);
    expect(made?.pos.y).toBeLessThan(boat.pos.y);
    expect(made?.phase).toBe('enabled');

    const after = hostBoat(runtime);
    expect(after.countermeasure.status).toBe('reloading');
    expect(after.transients.some((t) => t.kind === 'countermeasure-drop')).toBe(true);
  });

  it('leaves the tubes alone — it is a slot of its own, not one of them', () => {
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);
    runtime.drop('host', boat.id);
    expect(hostBoat(runtime).tubes.every((tube) => tube.status === 'loaded')).toBe(true);
  });

  it('refuses a second one until the launcher has refilled', () => {
    // Silently, like a salvo against a reloading tube: the countdown is already on the player's
    // screen and the pip not moving *is* the refusal (`protocol/weapon.ts`).
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);

    expect(runtime.drop('host', boat.id)).toBe(true);
    expect(runtime.drop('host', boat.id)).toBe(false);
    expect(runtime.state.torpedoes).toHaveLength(1);
  });

  it('refuses a boat the account does not command', () => {
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);
    expect(runtime.drop('foe', boat.id)).toBe(false);
    expect(runtime.drop('watcher', boat.id)).toBe(false);
    expect(runtime.state.torpedoes).toHaveLength(0);
  });

  it('sends the launcher’s state to the account that commands the boat, and to nobody else', () => {
    // Private on the same terms the tubes are: the noisemaker already in the water is the loudest
    // thing in the ocean and everyone is welcome to it, but *whether he has another one* is a plan
    // (`match/view.ts#OwnBoatDetail`).
    const runtime = new MatchRuntime(match());
    const boat = hostBoat(runtime);
    runtime.drop('host', boat.id);

    const mine = viewFor(runtime.state, 'host').own.find((own) => own.id === boat.id);
    expect(mine?.countermeasure.status).toBe('reloading');
    expect(viewFor(runtime.state, 'foe').own.some((own) => own.id === boat.id)).toBe(false);
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
    // A spectator is the exception, and on purpose: they have no picture to earn one with, so
    // they get both fleets' weapons on the same footing as the ground-truth terrain `setupFor`
    // hands them. It is also what makes the scope's track lines mean anything for them.
    expect(viewFor(runtime.state, 'watcher').torpedoes).toHaveLength(1);
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

  it('takes the boat’s contact down with it, so no silhouette outlives the hull', () => {
    // The other half of the same regression the decoy test drives: `contactHoldSeconds` is
    // infinite, so a contact nobody drops is a marker for the rest of the match. A boat sunk
    // after it slipped detection used to leave its last-known silhouette standing wherever it
    // was last heard, while the wreck channel drew the same hull, unconditionally, at the place
    // it actually died (`match/view.ts#WreckView`). One hull, two marks, one of them a lie.
    const runtime = new MatchRuntime(place(match(), { x: 1500, y: 500 }, { x: 1900, y: 500 }));
    const boat = hostBoat(runtime);
    const target = runtime.state.boats.find((candidate) => candidate.team === 'team2');
    runtime.fire('host', boat.id, [0], { x: 1700, y: 500 });

    /** How many hostile submarines team 1 believes it is looking at. */
    const hulls = () =>
      runtime.visionFor('host', 'team1')?.contacts.filter((c) => c.kind === 'boat').length ?? 0;
    const sunk = () =>
      runtime.state.boats.find((candidate) => candidate.id === target?.id)?.status === 'destroyed';

    // It is close enough to hear from the start, so the contact is held long before the warhead
    // arrives — which is what makes the marker's disappearance afterwards mean something.
    let held = false;
    for (let i = 0; i < 60 * SIM_TICK_HZ && !sunk(); i += 1) {
      runtime.tick();
      held ||= hulls() > 0;
    }
    expect(held).toBe(true);
    expect(sunk()).toBe(true);

    // The wreck still reflects and still lights team 1's picture (`sightingFor`), and the wreck
    // channel still draws it. What is gone is the contact, and it does not come back.
    for (let i = 0; i < 6 * SIM_TICK_HZ; i += 1) {
      runtime.tick();
      expect(hulls()).toBe(0);
    }
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

  it('drops its contact from both teams the tick it goes off, while the bang rings down', () => {
    // A spent weapon stays in the water to ring its four-second bang down, so its squares still
    // light a picture — but the blip was dropped the tick it detonated, for both sides, and
    // `confirm: false` stops the corpse being re-minted while the bang is still loud.
    const runtime = new MatchRuntime(place(match(), { x: 1500, y: 500 }, { x: 1900, y: 500 }));
    const boat = hostBoat(runtime);
    // A super-cavitating weapon: the loudest continuous thing in the game, so it confirms as a
    // contact while it runs, then detonates against the boat it is aimed at.
    runtime.load('host', boat.id, 0, 'super-cavitating', true);
    for (let i = 0; i < 40 * SIM_TICK_HZ; i += 1) {
      if (hostBoat(runtime).tubes[0]?.status === 'loaded') break;
      runtime.tick();
    }
    runtime.fire('host', boat.id, [0], { x: 1700, y: 500 });

    let seen = false;
    for (let i = 0; i < 60 * SIM_TICK_HZ; i += 1) {
      if (!runtime.tick()) continue;
      if (runtime.state.torpedoes[0]?.phase === 'spent') break;
      seen ||=
        runtime.visionFor('foe', 'team2')?.contacts.some((c) => c.kind === 'torpedo') ?? false;
    }
    expect(runtime.state.torpedoes[0]?.phase).toBe('spent');
    expect(seen).toBe(true);

    // Neither team is handed another torpedo contact while the corpse rings down — the firing
    // team never had one (friendly), and the target's is gone for good, not fading.
    for (let i = 0; i < 6 * SIM_TICK_HZ; i += 1) {
      if (!runtime.tick()) continue;
      expect(runtime.visionFor('host', 'team1')?.contacts.some((c) => c.kind === 'torpedo')).toBe(
        false,
      );
      expect(runtime.visionFor('foe', 'team2')?.contacts.some((c) => c.kind === 'torpedo')).toBe(
        false,
      );
    }
  });

  // Two full minutes of simulation: a decoy's clock is what ends it, and there is no shorter
  // road to the bug — an end that never reports a detonation is the whole of what is being
  // tested. Given its own timeout rather than the 5 s default for that reason alone.
  it('drops the contact of a load that ends with no bang at all', () => {
    // The regression: `contactHoldSeconds` is infinite, so a contact that is never dropped is a
    // marker on the scope and the mini-map for the rest of the match. A warhead reports a
    // detonation and gets dropped on it; a decoy or a drone runs out of clock and scuttles
    // silently (`sim/weapons/phase.ts`), so a rule keyed on detonations left one behind every
    // time. A decoy is the worst case of it — the marker is a full submarine silhouette the
    // enemy chased on purpose — so it is the one this test drives to expiry.
    const runtime = new MatchRuntime(place(match(), { x: 1500, y: 500 }, { x: 1900, y: 500 }));
    const boat = hostBoat(runtime);
    runtime.load('host', boat.id, 0, 'active-decoy', true);
    for (let i = 0; i < 40 * SIM_TICK_HZ; i += 1) {
      if (hostBoat(runtime).tubes[0]?.status === 'loaded') break;
      runtime.tick();
    }
    runtime.fire('host', boat.id, [0], { x: 1700, y: 400 });
    const decoy = runtime.state.torpedoes[0];
    expect(decoy?.mimic).not.toBeNull();

    /** How many hostile submarines team 2 believes it is looking at. */
    const hulls = () =>
      runtime.visionFor('foe', 'team2')?.contacts.filter((c) => c.kind === 'boat').length ?? 0;

    // An unpinged decoy passes as a boat, so the foe should end up holding two silhouettes: the
    // submarine that fired, and the one that is not there.
    let both = false;
    for (let i = 0; i < 20 * SIM_TICK_HZ && !both; i += 1) {
      if (!runtime.tick()) continue;
      both = hulls() === 2;
    }
    expect(both).toBe(true);

    // Now run it out. `lifetimeSeconds` is what ends a decoy — the range is written slack against
    // it — and nothing detonates, so this is exactly the path that used to leak.
    const lifetime = getWeapon('active-decoy').lifetimeSeconds;
    for (let i = 0; i < (lifetime + 2) * SIM_TICK_HZ; i += 1) runtime.tick();

    expect(runtime.state.torpedoes).toHaveLength(0);
    // Back to one: the boat that is really there. The decoy's marker did not fade — there is no
    // fade to reach, `contactHoldSeconds` being infinite — it was dropped.
    expect(hulls()).toBe(1);
  }, 30_000);
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
    const standard = getWeapon('active-torpedo');
    const scv = getWeapon('super-cavitating');

    expect(scv.speed).toBeGreaterThan(standard.speed * 2);
    // The sprinter's one weakness, now that the pitch band is gone: it turns half as fast at
    // two and a half times the speed, so its circle is six times the other's and it cannot be
    // talked out of the line it left the tube on.
    expect(scv.turnRate).toBeLessThan(standard.turnRate);
    expect(turningRadius('super-cavitating')).toBeGreaterThan(turningRadius('active-torpedo') * 5);
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

  /**
   * A drone awake and under way, on a transect that passes close down the enemy's side.
   *
   * **Close** is the word doing the work, and it is a balance fact rather than a convenience. The
   * drone's ears are worse than every hull's (`content/weapons.ts` — gain 1 against the Heavy's 2,
   * self-noise 2 against a stopped boat's −6), so against the quietest thing in the game — a Light
   * sitting still at its deployment band — it has to be inside a few hundred metres before it
   * registers anything at all. A submarine at rest would have found the same boat from about twice
   * as far. That is the drone: a worse listener, put where no boat of yours is.
   */
  const transect = (runtime: MatchRuntime, foe: BoatState) =>
    inject(
      runtime,
      'drone',
      { x: foe.pos.x - 200, y: foe.pos.y - 150 },
      { facing: 0, speed: getWeapon('drone').speed },
    );

  it('charts an enemy its own fleet is far too far away to hear', () => {
    const runtime = new MatchRuntime(match());
    const foe = foeBoat(runtime);
    // Deaf on its own account first — the whole test rests on this being true.
    expect(until(runtime, 4, () => boatContacts(runtime).length > 0)).toBe(false);

    transect(runtime, foe);
    expect(until(runtime, 20, () => boatContacts(runtime).length > 0)).toBe(true);

    // And it is the enemy boat, at roughly where the enemy boat is, rather than the team's own
    // weapon appearing in its own picture.
    const [contact] = boatContacts(runtime);
    expect(contact?.hull).toBe(foe.hull);
    expect(Math.abs((contact?.pos.x ?? 0) - foe.pos.x)).toBeLessThan(50);
  });

  it('hears while under way, and goes on past rather than stopping to listen', () => {
    // It cannot be steered and it does not stop, so its ears have to work at 9 m/s — which is what
    // the flat self-noise in the table is for (`sim/acoustics/torpedoes.ts`). Flat, and *poor*:
    // the number stands for a hydrophone bolted a few metres from its own screw.
    const runtime = new MatchRuntime(match());
    const foe = foeBoat(runtime);
    const launched = transect(runtime, foe);

    expect(until(runtime, 20, () => boatContacts(runtime).length > 0)).toBe(true);
    const flying = runtime.state.torpedoes.find((weapon) => weapon.id === launched.id);
    expect(flying?.speed).toBe(getWeapon('drone').speed);
    expect(flying?.pos.x).toBeGreaterThan(launched.pos.x);
    expect(flying?.pos.y).toBe(launched.pos.y);
  });

  it('gives itself away while it works, and the enemy sees it for what it is', () => {
    // The price of the drone, and it is not subtle even now that the pulse is the weakest of any
    // sonar in the game: 100 dB every two seconds plus a 56 dB motor, from something announcing
    // the bearing it is travelling along as it goes. A pulse is heard one way and images two, so
    // being the quietest pinger on the map does not stop it being reported from well outside
    // anything it can see.
    const runtime = new MatchRuntime(match());
    transect(runtime, foeBoat(runtime));

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

  it('is never named by the identification threshold while it is still passing as a boat', () => {
    // The classification band gives a team the type of a weapon that is honestly presenting as
    // one. It must not see through a disguise, however loudly the disguise is heard, because
    // seeing through it is a different mechanic with a much higher price — an active pulse that
    // tells everyone in the water where the listener is (`sim/weapons/decoy.ts`).
    //
    // Sat right on top of the enemy so the signal excess is as far past the threshold as the
    // model can put it: if anything could leak the load, this is the case that would.
    const runtime = new MatchRuntime(match());
    const foe = foeBoat(runtime);
    inject(runtime, 'active-decoy', { x: foe.pos.x - 60, y: foe.pos.y }, { speed: 8 });

    expect(until(runtime, 20, () => contacts(runtime).length > 0)).toBe(true);
    const [contact] = contacts(runtime);
    expect(contact?.kind).toBe('boat');
    expect(contact?.weapon).toBeNull();
  });

  it('is named once a pulse has stripped it and the squares are loud enough', () => {
    // The other half of the same rule: once it has stopped pretending, it classifies like any
    // other weapon. The contact keeps its id through both transitions.
    const runtime = new MatchRuntime(match());
    const foe = foeBoat(runtime);
    inject(runtime, 'active-decoy', { x: foe.pos.x - 60, y: foe.pos.y }, { speed: 8 });

    expect(until(runtime, 20, () => contacts(runtime).length > 0)).toBe(true);
    const fooled = contacts(runtime)[0];

    runtime.setActiveSonar('foe', foe.id, true);
    expect(until(runtime, 10, () => contacts(runtime)[0]?.weapon === 'active-decoy')).toBe(true);
    expect(contacts(runtime)[0]?.id).toBe(fooled?.id);
  });

  it('is named at the very edge of pulse range, where the reveal is weakest', () => {
    // The reveal and the naming are two different measurements, and this is the range that pulls
    // them furthest apart: the last metre at which `decoyRevealedBy` still returns true. Under
    // the current tuning the pinging boat's own return also happens to clear
    // `identificationThreshold` here, so this passes either way today — but that coincidence is
    // a fact about `content/acoustics.ts`, not a guarantee. The guarantee is
    // `ContactSighting.classified` (`match/vision.ts`), and the unit tests in `match-vision`
    // are what hold it; this one pins the end-to-end path so a future tuning pass that pulls
    // the two apart shows up here as a decoy that strips but will not name itself.
    const runtime = new MatchRuntime(match());
    const foe = foeBoat(runtime);
    inject(runtime, 'active-decoy', { x: foe.pos.x - 1000, y: foe.pos.y }, { speed: 8 });

    expect(until(runtime, 20, () => contacts(runtime).length > 0)).toBe(true);
    expect(contacts(runtime)[0]?.weapon).toBeNull();

    runtime.setActiveSonar('foe', foe.id, true);
    expect(until(runtime, 10, () => contacts(runtime)[0]?.kind === 'torpedo')).toBe(true);
    expect(contacts(runtime)[0]?.weapon).toBe('active-decoy');
  });
});

describe('the weapon icons', () => {
  // The tip is the classification and it has to survive being three pixels tall, so it is the one
  // property of the shapes worth asserting on. Everything else about them is taste.
  const tip = (id: WeaponId) => {
    const [nose] = getWeapon(id).silhouette;
    return nose;
  };

  it('gives every load an outline authored at unit length', () => {
    // The consumers multiply by the size they want (`client/render/silhouette.ts`), so a shape
    // authored in metres by mistake would draw a weapon the width of the map.
    for (const id of WEAPON_IDS) {
      const outline = getWeapon(id).silhouette;
      expect(outline.length).toBeGreaterThanOrEqual(3);
      for (const [x, y] of outline) {
        expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(y)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('points every load along +x, so placement can mirror rather than rotate', () => {
    for (const id of WEAPON_IDS) {
      expect(tip(id)).toEqual([0.5, 0]);
    }
  });

  it('gives the two offensive loads a sharp tip and the two tactical ones a round one', () => {
    // A sharp tip is one vertex from the nose to the full beam; a round one walks an arc, so the
    // vertex after the nose is barely off the centreline. That difference is the whole convention.
    const dropAfterNose = (id: WeaponId) => Math.abs(getWeapon(id).silhouette[1]?.[1] ?? 0);

    for (const id of ['active-torpedo', 'super-cavitating'] as const) {
      expect(dropAfterNose(id)).toBeGreaterThan(0.05);
    }
    for (const id of ['active-decoy', 'drone'] as const) {
      expect(dropAfterNose(id)).toBeLessThan(0.075);
    }
  });

  it('keeps every deployable load apart from the others', () => {
    // Four identical darts is the thing this replaced. Vertex counts differ because the shapes
    // genuinely describe different objects, which is a cheap proxy for "these are not the same
    // drawing with a different name on it".
    const shapes = DEPLOYABLE_WEAPON_IDS.map((id) => JSON.stringify(getWeapon(id).silhouette));
    expect(new Set(shapes).size).toBe(DEPLOYABLE_WEAPON_IDS.length);
  });
});
