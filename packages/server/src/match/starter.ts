/**
 * @seg/server/match/starter — turns an authorized, ready lobby into a begun match.
 *
 * This is the seam `LobbyHandler` calls once `service.start` has authorized a start. It owns
 * nothing about sockets or lobbies: it mints a match id, picks a seed, generates the map the
 * lobby asked for, loads every player's fleet, deploys it, remembers the result in the
 * `MatchStore`, and hands back the state. Injecting it is what keeps the handler's protocol
 * tests free of generation and storage details.
 *
 * It is asynchronous because loading fleets is. That is worth naming: the lobby holds only a
 * *summary* of each member's selection — a name and a point total — because the boats are
 * private to their owner until the match starts (planning/06 §3), so the only place the hulls
 * are read is here, from the account that owns them.
 *
 * It is now asynchronous for a second reason as well: putting the match on a worker thread means
 * waiting for that thread to load its entry point and build the runtime (`match/worker/pool.ts`).
 * That is also where a start can be *refused* — a server already running its maximum number of
 * matches has nowhere to put another, which `AtCapacityError` reports as a normal condition rather
 * than a failure.
 */

import { randomInt, randomUUID } from 'node:crypto';

import {
  deployMatch,
  generateMap,
  type AccountId,
  type BoatTemplate,
  type DeployingPlayer,
  type LobbyState,
  type MatchId,
  type MatchState,
} from '@seg/shared';

import type { LobbyRosterEntry } from '../lobby/service.js';
import type { MatchStore } from './store.js';

/**
 * Reads one account's saved fleet into its boats.
 *
 * Returns an empty list for a fleet that is missing or is not theirs — the same conflation
 * `LobbyFleetLookup` makes, and for the same reason: a caller must not be able to tell those
 * apart. A player who reaches match start with no readable fleet deploys nothing, which is
 * visible and recoverable, rather than taking the whole match down with them.
 */
export type FleetLoader = (
  accountId: AccountId,
  fleetId: string,
) => Promise<readonly BoatTemplate[]>;

export interface MatchStarterOptions {
  readonly store: MatchStore;
  /** Absent, every player deploys empty — useful in protocol tests, useless in a match. */
  readonly loadFleet?: FleetLoader;
  /**
   * Injected so a test can force a seed and assert the map is the one it picked — the map is
   * content, so a seed is not something the server should ever pick twice for a lobby.
   */
  readonly generateSeed?: () => number;
  /** Injected so a test can name the match. */
  readonly createMatchId?: () => MatchId;
  /** Injected so tests control time without sleeping. */
  readonly clock?: () => number;
}

export type MatchStarter = (
  lobby: LobbyState,
  roster: readonly LobbyRosterEntry[],
) => Promise<MatchState>;

/** The bounded range a seed is drawn from, so tests can assert "some seed in range". */
export const SEED_RANGE = 2 ** 31;

/**
 * The server is already running as many matches as it is configured to.
 *
 * An error class rather than a `null` return, because this has to travel up through
 * `LobbyStartMatch` — whose contract is "resolve with a match id" — to reach the one place that can
 * do something about it, which is the host who pressed start. `LobbyHandler` catches it by type and
 * turns it into a rejection the lobby survives.
 *
 * Carries the numbers so the message can be specific. "The server is full" is worth rather less to
 * whoever is reading the logs than "32 of 32".
 */
export class AtCapacityError extends Error {
  constructor(
    readonly running: number,
    readonly limit: number,
  ) {
    super(`the server is running its maximum of ${String(limit)} matches`);
    this.name = 'AtCapacityError';
  }
}

export function createMatchStarter(options: MatchStarterOptions): MatchStarter {
  const { store } = options;
  const generateSeed = options.generateSeed ?? (() => randomInt(0, SEED_RANGE));
  const createMatchId = options.createMatchId ?? (() => randomUUID());
  const clock = options.clock ?? (() => Date.now());

  return async (lobby, roster) => {
    const matchId = createMatchId();
    const map = generateMap(lobby.settings.mapType, {
      seed: generateSeed(),
      mapSize: lobby.settings.mapSize,
    });

    // Sequential rather than concurrent, deliberately: the roster is at most sixteen rows and
    // deployment must be reproducible, so reading them in a fixed order costs a few
    // milliseconds and removes a source of nondeterminism from the one function a replay
    // depends on being pure (planning/04 §9).
    const players: DeployingPlayer[] = [];
    for (const entry of roster) {
      players.push({
        accountId: entry.accountId,
        username: entry.username,
        position: entry.position,
        boats: await boatsFor(entry),
      });
    }

    const state = deployMatch({
      matchId,
      mode: lobby.settings.mode,
      map,
      startedAt: clock(),
      players,
      debugMode: lobby.settings.debugMode,
    });

    // Last, and the only step that can be refused for a reason that is nobody's mistake. The map
    // is generated and the fleets are read *before* a thread is asked for, which is the right order
    // even though it wastes that work on a refusal: holding a slot across two awaits would let a
    // start that then failed on a bad fleet keep a thread reserved, and the map generation is the
    // part most likely to throw.
    if (!(await store.begin(state, lobby.settings.name))) {
      const { running, limit } = store.capacity;
      throw new AtCapacityError(running, limit);
    }
    return state;
  };

  async function boatsFor(entry: LobbyRosterEntry): Promise<readonly BoatTemplate[]> {
    if (entry.fleetId === null || options.loadFleet === undefined) return [];
    if (entry.position === 'spectator') return [];
    return options.loadFleet(entry.accountId, entry.fleetId);
  }
}
