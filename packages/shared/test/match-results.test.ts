/**
 * When a match is over, and what everyone is then told.
 *
 * Two halves, and they fail differently. **The decision** is a rule about a scoreboard, so it is
 * tested by handing it scoreboards — a fleet wiped out, a target reached, a clock at zero, and
 * the ties each of those can produce. Getting one of these wrong ends a match on the wrong number
 * or does not end it at all, and neither looks like a bug from inside the match.
 *
 * **The record** is a projection, so it is tested the way the other projections are: against a
 * real `deployMatch` state rather than a hand-written literal, because a fixture that invented
 * its own fleet would keep passing after the shape it is projecting from changed.
 */

import {
  buildResults,
  decideAbandonment,
  decideMatch,
  deployMatch,
  describeWinReason,
  generateMap,
  SIM_TICK_HZ,
  type BoatTally,
  type BoatTemplate,
  type DeployingPlayer,
  type EntityId,
  type MatchState,
  type TeamId,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

const LIGHT: BoatTemplate = { name: 'S-01', hull: 'light', modules: [] };
const HEAVY: BoatTemplate = { name: 'E-01', hull: 'heavy', modules: [] };

function player(
  accountId: string,
  position: DeployingPlayer['position'],
  boats: readonly BoatTemplate[] = [LIGHT],
): DeployingPlayer {
  return { accountId, username: accountId, position, boats };
}

function match(mode: MatchState['mode'] = 'objective-capture'): MatchState {
  return deployMatch({
    matchId: 'm1',
    mode,
    map: generateMap('empty', { seed: 7, mapSize: 'small' }),
    startedAt: 0,
    players: [player('host', 'team1', [LIGHT, HEAVY]), player('foe', 'team2')],
  });
}

/** The same state with one team's standing overwritten — the scoreboard the rule reads. */
function standing(
  state: MatchState,
  team: TeamId,
  patch: Partial<MatchState['teams'][TeamId]>,
): MatchState {
  return { ...state, teams: { ...state.teams, [team]: { ...state.teams[team], ...patch } } };
}

/** Wind the clock to the given remaining seconds, leaving everything else alone. */
function atRemaining(state: MatchState, remainingSeconds: number): MatchState {
  const elapsedSeconds = 30 * 60 - remainingSeconds;
  return {
    ...state,
    clock: { tick: elapsedSeconds * SIM_TICK_HZ, elapsedSeconds, remainingSeconds },
  };
}

/** The same state with every player's `connected` flag set, the scoreboard `decideAbandonment` reads. */
function connectedAs(state: MatchState, connected: boolean): MatchState {
  return { ...state, players: state.players.map((player) => ({ ...player, connected })) };
}

describe('decideMatch', () => {
  it('leaves a match that is still being played alone', () => {
    expect(decideMatch(match())).toBeNull();
  });

  it('ends on a wipe, and gives it to the side still in the water', () => {
    const state = standing(match(), 'team2', { boatsAlive: 0 });

    expect(decideMatch(state)).toEqual({ winner: 'team1', reason: 'wipe' });
  });

  it('calls a mutual wipe a draw rather than picking one', () => {
    const state = standing(standing(match(), 'team1', { boatsAlive: 0 }), 'team2', {
      boatsAlive: 0,
    });

    expect(decideMatch(state)).toEqual({ winner: 'draw', reason: 'wipe' });
  });

  it('does not read a side that brought nothing as a side that was destroyed', () => {
    // Nothing in the lobby produces one today. If it ever does, this is the difference between
    // a match that starts and a match that is over on tick one.
    const state = standing(match(), 'team2', { boatsAlive: 0, boatsTotal: 0 });

    expect(decideMatch(state)).toBeNull();
  });

  it('ends an objective match on the score target', () => {
    const state = match();
    const decided = decideMatch(standing(state, 'team2', { score: state.scoreTarget }));

    expect(decided).toEqual({ winner: 'team2', reason: 'score' });
  });

  it('ignores the score target in deathmatch, where nothing can ever reach it', () => {
    // Deathmatch carries a target it does not play for, and its `score` is always zero. A rule
    // that read the target in both modes would end a deathmatch the moment the target was zero.
    const state = { ...match('deathmatch'), scoreTarget: 0 };

    expect(decideMatch(state)).toBeNull();
  });

  it('ends on the clock, on the measure the mode is played for', () => {
    const objective = atRemaining(match(), 0);
    expect(decideMatch(standing(objective, 'team1', { score: 3 }))).toEqual({
      winner: 'team1',
      reason: 'time',
    });

    // Deathmatch is judged on surviving fleet points, where the objective score is always level
    // at zero — read the wrong field and every deathmatch ends in a draw.
    const death = atRemaining(match('deathmatch'), 0);
    expect(decideMatch(standing(death, 'team2', { survivingPoints: 400 }))).toEqual({
      winner: 'team2',
      reason: 'time',
    });
  });

  it('breaks a tie on time spent detected, and only then calls it a draw', () => {
    const level = atRemaining(match(), 0);

    // Less time heard by the enemy wins it (planning/06 §2.1).
    expect(decideMatch(standing(level, 'team2', { secondsDetected: 90 }))).toEqual({
      winner: 'team1',
      reason: 'time',
    });
    expect(decideMatch(level)).toEqual({ winner: 'draw', reason: 'time' });
  });

  it('refuses to decide a match that has already been decided', () => {
    const over = { ...standing(match(), 'team2', { boatsAlive: 0 }), phase: 'complete' as const };

    expect(decideMatch(over)).toBeNull();
  });

  it('describes every reason it can return', () => {
    expect(describeWinReason('score')).toMatch(/score/i);
    expect(describeWinReason('wipe')).toMatch(/destroyed/i);
    expect(describeWinReason('time')).toMatch(/time/i);
    expect(describeWinReason('abandoned')).toMatch(/abandoned/i);
  });
});

describe('decideAbandonment', () => {
  it('leaves a match alone while anyone is still connected', () => {
    const state = connectedAs(match(), true);
    expect(decideAbandonment(state)).toBeNull();

    const [team1, ...rest] = state.players;
    if (team1 === undefined) throw new Error('fixture needs a player');
    const oneLeft: MatchState = {
      ...state,
      players: [{ ...team1, connected: false }, ...rest],
    };
    expect(decideAbandonment(oneLeft)).toBeNull();
  });

  it('ends the match, unwon, the moment every player is gone', () => {
    const state = connectedAs(match(), false);
    expect(decideAbandonment(state)).toEqual({ winner: 'draw', reason: 'abandoned' });
  });

  it('does not read an empty roster as everyone having left', () => {
    const state: MatchState = { ...match(), players: [] };
    expect(decideAbandonment(state)).toBeNull();
  });

  it('refuses to decide a match that has already been decided', () => {
    const state = { ...connectedAs(match(), false), phase: 'complete' as const };
    expect(decideAbandonment(state)).toBeNull();
  });
});

describe('buildResults', () => {
  const DECISION = { winner: 'team1' as const, reason: 'wipe' as const };

  function tally(overrides: Partial<BoatTally> = {}): BoatTally {
    return {
      damageDealt: 0,
      sank: [],
      captures: 0,
      torpedoesFired: 0,
      destroyedTick: null,
      ...overrides,
    };
  }

  it('groups every boat under the player who commanded it, in fleet order', () => {
    const state = match();
    const results = buildResults(state, DECISION, new Map(), SIM_TICK_HZ);

    const host = results.players.find((entry) => entry.accountId === 'host');
    expect(host?.username).toBe('host');
    expect(host?.team).toBe('team1');
    expect(host?.boats.map((boat) => boat.index)).toEqual([0, 1]);
    expect(host?.boats.map((boat) => boat.name)).toEqual(['S-01', 'E-01']);
    expect(results.players.find((entry) => entry.accountId === 'foe')?.boats).toHaveLength(1);
  });

  it('carries both fleets, because the fog lifts when the match ends', () => {
    // The one payload that is not narrowed per recipient. If this ever starts filtering by team,
    // the results screen becomes a scoreboard and the reveal it exists for is gone.
    const results = buildResults(match(), DECISION, new Map(), SIM_TICK_HZ);
    const teams = results.players.flatMap((entry) => entry.boats.map((boat) => boat.team));

    expect(new Set(teams)).toEqual(new Set(['team1', 'team2']));
    expect(results.teams.map((team) => team.team)).toEqual(['team1', 'team2']);
  });

  it('reads a boat that survived and a boat that did not', () => {
    const state = match();
    const [mine, second] = state.boats;
    if (mine === undefined || second === undefined) throw new Error('fixture needs two boats');

    const wrecked: MatchState = {
      ...state,
      clock: { tick: 600, elapsedSeconds: 30, remainingSeconds: 1770 },
      boats: state.boats.map((boat) =>
        boat.id === mine.id ? { ...boat, hp: 0, status: 'destroyed' } : boat,
      ),
    };
    const tallies = new Map<EntityId, BoatTally>([[mine.id, tally({ destroyedTick: 200 })]]);

    const results = buildResults(wrecked, DECISION, tallies, SIM_TICK_HZ);
    const boats = results.players.flatMap((entry) => entry.boats);
    const lost = boats.find((boat) => boat.id === mine.id);
    const afloat = boats.find((boat) => boat.id === second.id);

    expect(lost?.sunk).toBe(true);
    expect(lost?.hp).toBe(0);
    // Ten seconds, not the thirty the match has run: a wreck's clock stopped when it did.
    expect(lost?.secondsAlive).toBe(10);
    expect(afloat?.sunk).toBe(false);
    // A boat still in the water was alive for the whole match, however long that turned out.
    expect(afloat?.secondsAlive).toBe(30);
    expect(afloat?.maxHp).toBe(afloat?.hp);
  });

  it('names the boats a boat sank, and drops an id that names nothing', () => {
    const state = match();
    const [mine] = state.boats;
    const victim = state.boats.find((boat) => boat.team === 'team2');
    if (mine === undefined || victim === undefined) throw new Error('fixture needs two sides');

    const tallies = new Map<EntityId, BoatTally>([
      [
        mine.id,
        tally({ sank: [victim.id, 9999], damageDealt: 42.6, captures: 2, torpedoesFired: 7 }),
      ],
    ]);

    const results = buildResults(state, DECISION, tallies, SIM_TICK_HZ);
    const killer = results.players
      .flatMap((entry) => entry.boats)
      .find((boat) => boat.id === mine.id);

    expect(killer?.sank).toEqual([
      { id: victim.id, name: victim.name, hull: victim.hull, team: 'team2' },
    ]);
    expect(killer?.damageDealt).toBeCloseTo(42.6);
    expect(killer?.captures).toBe(2);
    expect(killer?.torpedoesFired).toBe(7);
  });

  it('gives a boat nothing did anything with an empty card rather than a missing one', () => {
    const results = buildResults(match(), DECISION, new Map(), SIM_TICK_HZ);
    const boat = results.players.flatMap((entry) => entry.boats)[0];

    expect(boat?.damageDealt).toBe(0);
    expect(boat?.sank).toEqual([]);
    expect(boat?.torpedoesFired).toBe(0);
  });

  it('carries the outcome, the mode, and how long the match ran', () => {
    const state = atRemaining(match(), 300);
    const results = buildResults(state, { winner: 'draw', reason: 'time' }, new Map(), SIM_TICK_HZ);

    expect(results.matchId).toBe('m1');
    expect(results.mode).toBe('objective-capture');
    expect(results.winner).toBe('draw');
    expect(results.reason).toBe('time');
    expect(results.scoreTarget).toBe(state.scoreTarget);
    expect(results.durationSeconds).toBe(state.clock.elapsedSeconds);
  });

  it('keeps a spectator in the roster with no boats under them', () => {
    const state = deployMatch({
      matchId: 'm1',
      mode: 'deathmatch',
      map: generateMap('empty', { seed: 7, mapSize: 'small' }),
      startedAt: 0,
      players: [
        player('host', 'team1'),
        player('foe', 'team2'),
        { accountId: 'watcher', username: 'watcher', position: 'spectator', boats: [] },
      ],
    });

    const watcher = buildResults(state, DECISION, new Map(), SIM_TICK_HZ).players.find(
      (entry) => entry.accountId === 'watcher',
    );

    expect(watcher?.team).toBeNull();
    expect(watcher?.boats).toEqual([]);
  });
});
