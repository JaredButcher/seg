/**
 * @seg/server/match/store — the in-memory record of running matches.
 *
 * Like lobbies, matches are **not persisted** — a server restart ends them (planning/07 §4).
 * What lives here is what a reconnecting player needs to be re-sent (`match.state`, Q21): the
 * map today, the sim snapshot as the runtime lands. It is deliberately a dumb registry with no
 * rules of its own; lifecycle decisions belong to the match runtime that this store outlives.
 */

import type { GeneratedMap, MatchId } from '@seg/shared';

interface MatchRecord {
  readonly matchId: MatchId;
  readonly map: GeneratedMap;
}

export class MatchStore {
  private readonly matches = new Map<MatchId, MatchRecord>();

  /** Remember a match that has begun. The map is generated once and shared by every member. */
  store(matchId: MatchId, map: GeneratedMap): void {
    this.matches.set(matchId, { matchId, map });
  }

  /** The map of a running match, for reconnect-restore. `undefined` when it is not found. */
  mapFor(matchId: MatchId): GeneratedMap | undefined {
    return this.matches.get(matchId)?.map;
  }

  /** Drop a match that has ended. */
  remove(matchId: MatchId): void {
    this.matches.delete(matchId);
  }
}
