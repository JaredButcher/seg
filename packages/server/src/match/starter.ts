/**
 * @seg/server/match/starter — turns an authorized, ready lobby into a begun match.
 *
 * This is the seam `LobbyHandler` calls once `service.start` has authorized a start. It owns
 * nothing about sockets or lobbies: it mints a match id, picks a seed, generates the map the
 * lobby asked for, remembers it in the `MatchStore`, and returns the payload every member is
 * sent. Injecting it is what keeps the handler's protocol tests free of generation details.
 */

import { randomInt, randomUUID } from 'node:crypto';

import { createMatchState, generateMap, type LobbyState, type MatchId } from '@seg/shared';

import type { MatchStore } from './store.js';

export interface MatchStarterOptions {
  readonly store: MatchStore;
  /**
   * Injected so a test can force a seed and assert the map is the one it picked — the map is
   * content, so a seed is not something the server should ever pick twice for a lobby.
   */
  readonly generateSeed?: () => number;
  /** Injected so a test can name the match. */
  readonly createMatchId?: () => MatchId;
}

export type MatchStarter = (lobby: LobbyState) => ReturnType<typeof createMatchState>;

/** The bounded range a seed is drawn from, so tests can assert "some seed in range". */
export const SEED_RANGE = 2 ** 31;

export function createMatchStarter(options: MatchStarterOptions): MatchStarter {
  const { store } = options;
  const generateSeed = options.generateSeed ?? (() => randomInt(0, SEED_RANGE));
  const createMatchId = options.createMatchId ?? (() => randomUUID());

  return (lobby) => {
    const matchId = createMatchId();
    const map = generateMap(lobby.settings.mapType, {
      seed: generateSeed(),
      mapSize: lobby.settings.mapSize,
    });
    store.store(matchId, map);
    return createMatchState(matchId, lobby.settings.mode, map);
  };
}
