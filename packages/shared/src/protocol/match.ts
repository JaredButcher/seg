/**
 * @seg/shared/protocol/match — the match-start messages.
 *
 * Split into an event and a payload on purpose (planning/06 §1, Q21): `match.started` is a
 * one-shot "the match has begun, leave the lobby view" signal, while `match.state` is the
 * replayable data a client needs to render the world — the map now, sim state later. They are
 * separate so a reconnecting player can be re-sent `match.state` (and the start signal) without
 * the match having started again.
 *
 * Both travel on the `control` channel, so delivery to a seated player is reliable and ordered;
 * the ordering between the two is not relied on by the client, which treats each as
 * interpretable alone (planning/02 §3.3).
 */

import type { GameMode } from '../lobby/settings.js';
import type { GeneratedMap } from '../map/types.js';
import type { Envelope } from './schema.js';

/** Identifies one running match, for the lifetime of the process. */
export type MatchId = string;

/** "A match has begun." Sent to every member of the starting lobby. */
export interface MatchStartedMessage extends Envelope {
  readonly t: 'match.started';
  readonly matchId: MatchId;
}

/**
 * The full current match payload: the generated map, and later the sim snapshot.
 *
 * Sent to every member when the match starts, and re-sent to a player who reconnects (Q21) —
 * which is exactly why it is separate from `match.started`: the data does not change when the
 * event happens again.
 */
export interface MatchStateMessage extends Envelope {
  readonly t: 'match.state';
  readonly matchId: MatchId;
  /** The lobby's mode — what the HUD's score area reads, and what a reconnect restores. */
  readonly mode: GameMode;
  readonly map: GeneratedMap;
}

export type MatchServerMessage = MatchStartedMessage | MatchStateMessage;

// ── helpers ─────────────────────────────────────────────────────────────────────────

export function createMatchStarted(matchId: MatchId): MatchStartedMessage {
  return { t: 'match.started', matchId };
}

export function createMatchState(
  matchId: MatchId,
  mode: GameMode,
  map: GeneratedMap,
): MatchStateMessage {
  return { t: 'match.state', matchId, mode, map };
}
