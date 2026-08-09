/**
 * The projection, which is where "never put ground truth on the wire" is enforced
 * (planning/01 §5, rule 2).
 *
 * These are the tests that matter most in the whole match model. A bug in deployment puts a
 * boat in the wrong place; a bug here hands a player the enemy fleet, and it would never show
 * up as a visible defect — the HUD would simply have data it quietly did not draw.
 */

import {
  OBJECTIVE_RADIUS,
  deployMatch,
  generateMap,
  setupFor,
  teamFor,
  viewFor,
  type BoatTemplate,
  type DeployingPlayer,
  type MatchState,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

const LIGHT: BoatTemplate = { name: 'S-01', hull: 'light', modules: [] };
const HEAVY: BoatTemplate = { name: 'S-02', hull: 'heavy', modules: [] };

/** Deliberately a number nothing else in a chart could be, so "the seed is not in here" bites. */
const SEED = 987_654_321;

function player(
  accountId: string,
  position: DeployingPlayer['position'],
  boats: readonly BoatTemplate[] = [],
): DeployingPlayer {
  return { accountId, username: accountId, position, boats };
}

function match(): MatchState {
  return deployMatch({
    matchId: 'm1',
    mode: 'objective-capture',
    map: generateMap('empty', { seed: SEED, mapSize: 'small' }),
    startedAt: 5_000,
    players: [
      player('host', 'team1', [LIGHT, HEAVY]),
      player('mate', 'team1', [LIGHT]),
      player('foe', 'team2', [LIGHT, HEAVY]),
      player('watcher', 'spectator'),
    ],
  });
}

describe('setupFor', () => {
  it('carries your own side’s boats and no trace of the other', () => {
    const state = match();
    const setup = setupFor(state, 'host');

    expect(state.boats).toHaveLength(5);
    expect(setup.fleet).toHaveLength(3);
    expect(setup.fleet.every((boat) => boat.team === 'team1')).toBe(true);

    // Not "filtered out of the render" — absent. Nothing in the payload names an enemy boat.
    const serialized = JSON.stringify(setup);
    for (const enemy of state.boats.filter((boat) => boat.team === 'team2')) {
      expect(serialized).not.toContain(`"id":${String(enemy.id)}`);
    }
  });

  it('includes a teammate’s stat block, because an ally’s limits are yours to plan around', () => {
    const setup = setupFor(match(), 'host');
    const mates = setup.fleet.filter((boat) => boat.owner === 'mate');

    expect(mates).toHaveLength(1);
    expect(mates[0]?.stats.crushDepth).toBeGreaterThan(0);
  });

  it('tells each player which side they are on, and the roster of both', () => {
    const state = match();

    expect(setupFor(state, 'host').you).toEqual({ accountId: 'host', team: 'team1' });
    expect(setupFor(state, 'foe').you).toEqual({ accountId: 'foe', team: 'team2' });
    expect(setupFor(state, 'watcher').you).toEqual({ accountId: 'watcher', team: null });

    // Who is playing was public in the lobby and stays public. What they brought does not.
    expect(setupFor(state, 'host').players.map((p) => p.accountId)).toEqual([
      'host',
      'mate',
      'foe',
      'watcher',
    ]);
  });

  it('gives a spectator no fleet at all until spectator vision is settled', () => {
    const setup = setupFor(match(), 'watcher');

    expect(setup.fleet).toEqual([]);
  });

  it('carries no zones at all — they move, so they ride the view frame', () => {
    // A captured objective is replaced somewhere else (`match/objectives.ts`), so a position
    // sent once in the static half would be wrong from the first point scored.
    expect(setupFor(match(), 'host')).not.toHaveProperty('zones');
  });

  it('gives an account that is not in the match nothing', () => {
    const state = match();

    expect(teamFor(state, 'stranger')).toBeNull();
    expect(setupFor(state, 'stranger').fleet).toEqual([]);
    expect(viewFor(state, 'stranger').boats).toEqual([]);
  });

  it('gives a player the frame of the world and none of its rock', () => {
    // ADR 0002 reverses C12: a player starts uncharted and fills the map in by sonar. What
    // they are told for free is how big the ocean is, which is what makes a camera possible.
    const state = match();
    const chart = setupFor(state, 'host').map;

    expect(chart.terrain).toBeNull();
    expect(chart.extents).toEqual(state.map.extents);
    expect(chart.depthScale).toBe(state.map.depthScale);
  });

  it('never puts the map seed on a player’s wire', () => {
    // The one that would make everything else theatre: generation is pure and lives in a
    // package the client bundles, so a seed is the terrain, reproducible in one line.
    const chart = setupFor(match(), 'host').map;

    expect(Object.keys(chart)).not.toContain('seed');
    expect(JSON.stringify(chart)).not.toContain(String(SEED));
  });

  it('gives a spectator ground truth, because they have no sonar of their own', () => {
    // A cave map rather than open water, so "the spectator got the rock" is a claim with
    // something behind it.
    const state = deployMatch({
      matchId: 'm2',
      mode: 'deathmatch',
      map: generateMap('sparse', { seed: SEED, mapSize: 'small' }),
      startedAt: 5_000,
      players: [player('host', 'team1', [LIGHT]), player('watcher', 'spectator')],
    });

    expect(state.map.terrain.obstacles.length).toBeGreaterThan(0);
    expect(setupFor(state, 'watcher').map.terrain).toEqual(state.map.terrain);
    expect(setupFor(state, 'host').map.terrain).toBeNull();
  });

  it('sends a player no vision until a solve has produced some', () => {
    // The default matters: a projection with no runtime behind it must say "nothing heard",
    // never "here is the map".
    const view = viewFor(match(), 'host');

    expect(view.vision.charted).toEqual([]);
    expect(view.vision.cells).toEqual([]);
    expect(view.vision.contacts).toEqual([]);
  });
});

describe('viewFor', () => {
  it('shows your team’s boats moving and nobody else’s', () => {
    const view = viewFor(match(), 'host');

    expect(view.boats).toHaveLength(3);
    expect(view.boats.every((boat) => boat.pos.x < 2_000)).toBe(true);
  });

  it('keeps tube states private to the player who commands the boat', () => {
    const state = match();
    const view = viewFor(state, 'host');

    // Three friendly boats on the scope, two of them theirs to load and fire.
    expect(view.boats).toHaveLength(3);
    expect(view.own).toHaveLength(2);
    const mine = new Set(
      state.boats.filter((boat) => boat.owner === 'host').map((boat) => boat.id),
    );
    expect(view.own.every((own) => mine.has(own.id))).toBe(true);
  });

  it('publishes both teams’ scores, and neither team’s time detected', () => {
    const view = viewFor(match(), 'host');

    expect(view.teams.map((team) => team.team).sort()).toEqual(['team1', 'team2']);
    // The tiebreak stat is not a field. Your own figure rising would tell you the enemy can
    // hear you right now, which is the one thing the game is about not knowing.
    expect(JSON.stringify(view)).not.toContain('secondsDetected');
  });

  it('answers the cavitation question itself rather than leaving it to the client', () => {
    const view = viewFor(match(), 'host');

    // Every boat is stopped at deployment, so none of them is loud.
    expect(view.boats.every((boat) => boat.cavitating === false)).toBe(true);
  });

  it('carries the clock and the phase, so a frame is interpretable alone', () => {
    // planning/02 §3.3: `view` and `control` will be on different transports, and a frame
    // that needed the setup beside it to mean anything would be a bug that stays invisible
    // until one channel is briefly slower than the other.
    const view = viewFor(match(), 'host');

    expect(view.phase).toBe('active');
    expect(view.clock.tick).toBe(0);
    expect(view.clock.remainingSeconds).toBe(30 * 60);
    // Whole zones, not a status join against something the setup carried: position included,
    // because a captured objective is replaced somewhere else.
    expect(view.zones).toHaveLength(3);
    for (const zone of view.zones) {
      expect(zone.radius).toBe(OBJECTIVE_RADIUS);
      expect(zone.centre.x).toBeGreaterThan(0);
      expect(zone.capturing).toBeNull();
      expect(zone.armingTicks).toBe(0);
    }
  });
});
