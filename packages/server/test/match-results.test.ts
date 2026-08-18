/**
 * The end of a match: when the runtime calls it, what it counted on the way, and who is told.
 *
 * `match-results` in `@seg/shared` proves the *rule* against hand-built scoreboards. These are
 * the tests one level up — that the runtime asks the question on real ticks, that the tallies it
 * hands the results are the ones the simulation actually produced, and that a finished match
 * stops being a running one.
 *
 * The fleets are pulled together and placed rather than driven, for the reason `match-weapons`
 * gives: the deployment bands are at opposite ends of the world by design, which is right for a
 * match and useless for a test about what happens when a weapon arrives.
 */

import {
  CAPTURE_SECONDS,
  deployMatch,
  generateMap,
  MATCH_DURATION_SECONDS,
  SIM_TICK_HZ,
  standingFor,
  type BoatTemplate,
  type DeployingPlayer,
  type MatchState,
  type Vec2,
} from '@seg/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { MatchRuntime } from '../src/match/runtime.js';
import { fake, harness, type Fake, type MatchFixture } from './match-harness.js';

const MEDIUM: BoatTemplate = { name: 'S-02', hull: 'medium', modules: [] };
const LIGHT: BoatTemplate = { name: 'E-01', hull: 'light', modules: [] };

function player(
  accountId: string,
  position: DeployingPlayer['position'],
  boats: readonly BoatTemplate[] = [],
): DeployingPlayer {
  return { accountId, username: accountId, position, boats };
}

function match(mode: MatchState['mode'] = 'deathmatch'): MatchState {
  return deployMatch({
    matchId: 'm1',
    mode,
    map: generateMap('empty', { seed: 11, mapSize: 'small' }),
    startedAt: 0,
    players: [
      player('host', 'team1', [MEDIUM]),
      player('foe', 'team2', [LIGHT]),
      player('watcher', 'spectator'),
    ],
  });
}

/** Both boats where the test wants them, facing each other. */
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

/**
 * Sink a boat outright, standings and all.
 *
 * The standings are derived from the fleet and the runtime only recounts them on a tick that
 * moved something (`MatchRuntime.tick`), so a fixture that destroyed a hull and left the
 * scoreboard alone would be testing a state the simulation cannot produce.
 */
function sink(state: MatchState, boatId: number): MatchState {
  const boats = state.boats.map((boat) =>
    boat.id === boatId ? { ...boat, hp: 0, status: 'destroyed' as const } : boat,
  );
  return {
    ...state,
    boats,
    teams: {
      team1: standingFor('team1', boats, state.teams.team1),
      team2: standingFor('team2', boats, state.teams.team2),
    },
  };
}

function boatOf(runtime: MatchRuntime, team: 'team1' | 'team2') {
  const boat = runtime.state.boats.find((candidate) => candidate.team === team);
  if (boat === undefined) throw new Error(`no ${team} boat`);
  return boat;
}

describe('the end of a match', () => {
  it('is not over while both fleets are in the water', () => {
    const runtime = new MatchRuntime(match());
    for (let i = 0; i < 40; i += 1) runtime.tick();

    expect(runtime.results).toBeNull();
    expect(runtime.state.phase).toBe('active');
  });

  it('ends the tick a fleet is wiped out, and says who by', () => {
    const runtime = new MatchRuntime(match());
    runtime.replace(sink(runtime.state, boatOf(runtime, 'team2').id));

    expect(runtime.results).toBeNull();
    runtime.tick();

    expect(runtime.results?.winner).toBe('team1');
    expect(runtime.results?.reason).toBe('wipe');
    expect(runtime.state.phase).toBe('complete');
  });

  it('ends the tick everyone leaves, however far the fleets still are from a game-design win', () => {
    const runtime = new MatchRuntime(match());
    // Both fleets are fully afloat and untouched — no wipe, no score, no clock run out — so
    // abandonment is the only thing in reach that can end this tick.
    runtime.replace({
      ...runtime.state,
      players: runtime.state.players.map((player) => ({ ...player, connected: false })),
    });

    expect(runtime.results).toBeNull();
    runtime.tick();

    expect(runtime.results?.winner).toBe('draw');
    expect(runtime.results?.reason).toBe('abandoned');
    expect(runtime.state.phase).toBe('complete');
  });

  it('stops advancing once it is over, however long the driver keeps calling', () => {
    const runtime = new MatchRuntime(match());
    runtime.replace(sink(runtime.state, boatOf(runtime, 'team2').id));
    runtime.tick();

    const ended = runtime.state.clock.tick;
    const results = runtime.results;
    for (let i = 0; i < 100; i += 1) expect(runtime.tick()).toBe(false);

    expect(runtime.state.clock.tick).toBe(ended);
    // The same record, not a fresh one built every tick — a results screen that changed under
    // the player would be a match that never quite finished.
    expect(runtime.results).toBe(results);
  });

  it('ends on the clock, on the surviving fleet points, when nobody has been sunk', () => {
    const state = match();
    const elapsed = MATCH_DURATION_SECONDS - 1 / SIM_TICK_HZ;
    const runtime = new MatchRuntime({
      ...state,
      clock: {
        tick: Math.round(elapsed * SIM_TICK_HZ),
        elapsedSeconds: elapsed,
        remainingSeconds: 1 / SIM_TICK_HZ,
      },
    });

    runtime.tick();

    expect(runtime.results?.reason).toBe('time');
    // A Medium is worth more than a Light and neither has been touched, so the heavier fleet
    // takes it — which is the whole of "hide and survive is a losing strategy for whoever is
    // behind" (planning/06 §2.1).
    expect(runtime.results?.winner).toBe('team1');
    expect(runtime.results?.durationSeconds).toBeCloseTo(MATCH_DURATION_SECONDS);
  });

  it('ends an objective match on its score target, and credits the boats standing on the point', () => {
    // Target of one, so a single capture finishes it — the same rule the default ten runs, at a
    // length a test can spend.
    const base = deployMatch({
      matchId: 'm1',
      mode: 'objective-capture',
      map: generateMap('empty', { seed: 11, mapSize: 'small' }),
      startedAt: 0,
      players: [player('host', 'team1', [MEDIUM]), player('foe', 'team2', [LIGHT])],
    });
    const zone = base.zones[0];
    if (zone === undefined) throw new Error('fixture needs an objective');

    const runtime = new MatchRuntime({
      ...base,
      scoreTarget: 1,
      boats: base.boats.map((boat) =>
        boat.team === 'team1' ? { ...boat, pos: { ...zone.centre } } : boat,
      ),
    });

    for (let i = 0; i < CAPTURE_SECONDS * SIM_TICK_HZ + 5; i += 1) {
      runtime.tick();
      if (runtime.results !== null) break;
    }

    expect(runtime.results?.winner).toBe('team1');
    expect(runtime.results?.reason).toBe('score');

    const captor = runtime.results?.players
      .find((entry) => entry.accountId === 'host')
      ?.boats.find((boat) => boat.name === MEDIUM.name);
    expect(captor?.captures).toBe(1);
    // Nobody else was in the circle, and a boat that was not there is not credited with being.
    const other = runtime.results?.players
      .find((entry) => entry.accountId === 'foe')
      ?.boats.find((boat) => boat.name === LIGHT.name);
    expect(other?.captures).toBe(0);
  });
});

describe('what the results counted', () => {
  it('credits the boat that fired: the shot, the damage, and the kill', () => {
    const runtime = new MatchRuntime(place(match(), { x: 1500, y: 500 }, { x: 1900, y: 500 }));
    const shooter = boatOf(runtime, 'team1');
    const target = boatOf(runtime, 'team2');

    // Enabled well short of the target, so the seeker has the run in front of it.
    expect(runtime.fire('host', shooter.id, [0], { x: 1700, y: 500 })).toBe(1);

    for (let i = 0; i < 60 * SIM_TICK_HZ; i += 1) {
      runtime.tick();
      if (runtime.results !== null) break;
    }

    // The Light was the whole of team 2, so the kill is also the end of the match.
    expect(runtime.results?.reason).toBe('wipe');
    expect(runtime.results?.winner).toBe('team1');

    const card = runtime.results?.players
      .find((entry) => entry.accountId === 'host')
      ?.boats.find((boat) => boat.id === shooter.id);
    expect(card?.torpedoesFired).toBe(1);
    expect(card?.damageDealt).toBeGreaterThan(0);
    expect(card?.sank.map((victim) => victim.id)).toEqual([target.id]);
    expect(card?.sank[0]?.name).toBe(LIGHT.name);
    expect(card?.sunk).toBe(false);

    const wreck = runtime.results?.players
      .find((entry) => entry.accountId === 'foe')
      ?.boats.find((boat) => boat.id === target.id);
    expect(wreck?.sunk).toBe(true);
    expect(wreck?.hp).toBe(0);
    // It was alive for the run-out and not for the whole match, and the two are different
    // numbers as soon as the weapon takes any time at all to get there.
    expect(wreck?.secondsAlive).toBeGreaterThan(0);
    expect(wreck?.secondsAlive).toBeLessThanOrEqual(runtime.results?.durationSeconds ?? 0);
  });

  it('never credits more damage than the hull actually lost', () => {
    // A warhead reports its full yield against every hull it caught, which can be more than the
    // hull had left. If that ever reaches the screen, a four-boat fleet's damage figures add up
    // to more than the enemy ever brought and nobody believes any of them.
    const runtime = new MatchRuntime(place(match(), { x: 1500, y: 500 }, { x: 1900, y: 500 }));
    const shooter = boatOf(runtime, 'team1');
    const target = boatOf(runtime, 'team2');
    // A hull with almost nothing left, so overkill is the likely outcome of the first hit.
    runtime.replace({
      ...runtime.state,
      boats: runtime.state.boats.map((boat) => (boat.id === target.id ? { ...boat, hp: 2 } : boat)),
    });
    runtime.fire('host', shooter.id, [0], { x: 1700, y: 500 });

    for (let i = 0; i < 60 * SIM_TICK_HZ; i += 1) {
      runtime.tick();
      if (runtime.results !== null) break;
    }

    const card = runtime.results?.players
      .find((entry) => entry.accountId === 'host')
      ?.boats.find((boat) => boat.id === shooter.id);
    expect(card?.damageDealt).toBeGreaterThan(0);
    expect(card?.damageDealt).toBeLessThanOrEqual(2);
  });

  it('gives a boat that did nothing an honest set of zeroes', () => {
    const runtime = new MatchRuntime(match());
    runtime.replace(sink(runtime.state, boatOf(runtime, 'team2').id));
    runtime.tick();

    const idle = runtime.results?.players
      .find((entry) => entry.accountId === 'host')
      ?.boats.find((boat) => boat.name === MEDIUM.name);

    expect(idle?.damageDealt).toBe(0);
    expect(idle?.torpedoesFired).toBe(0);
    expect(idle?.sank).toEqual([]);
    expect(idle?.captures).toBe(0);
  });
});

describe('telling everyone', () => {
  let fixture: MatchFixture | null = null;

  afterEach(async () => {
    await fixture?.close();
    fixture = null;
  });

  /**
   * A match on a real thread that is one tick from being over, and the three connections its end
   * will be reported to.
   *
   * The wipe is arranged **before** `begin`, which is the one thing that changed when matches moved
   * onto worker threads: the state belongs to the worker from that call onward and this side has no
   * `MatchRuntime` to reach into (`match/worker/protocol.ts`). Handing over an already-sunk fleet
   * makes the same claim the old `runtime.replace(sink(...))` did, on the only side that still owns
   * the boats.
   */
  async function endgame(): Promise<{ started: MatchFixture; players: Fake[] }> {
    const started = harness();
    fixture = started;
    const players = ['host', 'foe', 'watcher'].map((accountId) => fake(accountId));
    for (const connection of players) started.connections.add(connection);

    const state = match();
    const doomed = state.boats.find((boat) => boat.team === 'team2');
    if (doomed === undefined) throw new Error('fixture needs a team 2 boat');

    await started.store.begin(sink(state, doomed.id), 'Test Lobby');
    started.handler.begin('m1');
    await started.sync();
    return { started, players };
  }

  it('sends the results to every player and every spectator, exactly once', async () => {
    const { started, players } = await endgame();
    for (const connection of players) connection.clear();

    // Three ticks against a match that ends on the first. Exactly-once is the store's guarantee
    // now rather than a clock's (`MatchStore.settle`), and it is the ticks *after* the end that
    // would break it.
    await started.ticks(3);

    for (const connection of players) {
      const results = connection.sent.filter((message) => message.t === 'match.results');
      expect(results).toHaveLength(1);
    }
  });

  it('stops ticking a match that is over, so the last frame is the last frame', async () => {
    const { started, players } = await endgame();
    const host = players[0];
    if (host === undefined) throw new Error('no host connection');

    await started.ticks(1);
    expect(started.store.digest('m1')?.phase).toBe('complete');

    // A frame's `tick` is this thread's only window onto the worker's clock, and it is the honest
    // one to assert on: a frame that advanced here is a world that kept moving.
    const ended = host.last('match.view')?.tick;
    expect(ended).toBeDefined();

    await started.ticks(4);
    expect(host.last('match.view')?.tick).toBe(ended);
  });

  it('hands the results to a player who arrives after the end', async () => {
    const { started, players } = await endgame();
    await started.ticks(1);

    const host = players[0];
    if (host === undefined) throw new Error('no host connection');
    started.connections.remove(host);

    const returning = fake('host');
    started.connections.add(returning);
    started.handler.attach(returning);
    await started.sync();

    // The whole picture, and then how it ended — a reconnecting player would otherwise land on a
    // live HUD over a world that stopped, with nothing to say why.
    //
    // Both, rather than the old assertion that the results came *last*. `attach` answers the
    // results from this thread and asks the worker for the picture, so the order they land in is
    // now a fact about the thread boundary rather than about the server's contract.
    expect(returning.types()).toContain('match.state');
    expect(returning.types()).toContain('match.results');
  });
});
