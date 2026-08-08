/**
 * @seg/shared/protocol/lobby — the lobby wire messages.
 *
 * **Every message here travels on the `control` channel, which is pinned to the WebSocket
 * permanently** (planning/02 §3.1, ADR 0001). That is not an implementation accident: lobby
 * traffic happens before a match exists and therefore before there is anything to negotiate
 * a data channel for, and it needs reliable ordered delivery — a dropped `lobby.join` is a
 * player staring at a screen that did not change.
 */

import type {
  AccountId,
  LobbyExitReason,
  LobbyId,
  LobbyListFilter,
  LobbySettingsPatch,
  LobbyState,
  LobbySummary,
} from '../lobby/state.js';
import type { LobbyPosition } from '../lobby/settings.js';
import type { Envelope } from './schema.js';

// ── client → server ─────────────────────────────────────────────────────────────────

/**
 * How a player identifies the lobby they want.
 *
 * A tagged union rather than two optional fields, so "exactly one of these" is expressed in
 * the type instead of being a validation rule someone forgets. It also keeps the message
 * describable in the binary codec's field-descriptor language (planning/02 §4): a tag plus
 * one field, not a free-form object.
 */
export type LobbyJoinTarget =
  { readonly by: 'code'; readonly code: string } | { readonly by: 'id'; readonly lobbyId: LobbyId };

/** Create a lobby. Everything except the name takes its default; change it with `lobby.modify`. */
export interface LobbyCreateMessage extends Envelope {
  readonly t: 'lobby.create';
  readonly name: string;
}

export interface LobbyJoinMessage extends Envelope {
  readonly t: 'lobby.join';
  readonly target: LobbyJoinTarget;
}

/** Move yourself between team 1, team 2, and the spectators. */
export interface LobbySetPositionMessage extends Envelope {
  readonly t: 'lobby.setPosition';
  readonly position: LobbyPosition;
}

export interface LobbyLeaveMessage extends Envelope {
  readonly t: 'lobby.leave';
}

/** Host only. */
export interface LobbyKickMessage extends Envelope {
  readonly t: 'lobby.kick';
  readonly accountId: AccountId;
}

/** Host only. */
export interface LobbyModifyMessage extends Envelope {
  readonly t: 'lobby.modify';
  readonly patch: LobbySettingsPatch;
}

/** Ask for the server browser. Public lobbies only — unlisted ones are never returned. */
export interface LobbyListMessage extends Envelope {
  readonly t: 'lobby.list';
  readonly filter: LobbyListFilter;
}

export type LobbyClientMessage =
  | LobbyCreateMessage
  | LobbyJoinMessage
  | LobbySetPositionMessage
  | LobbyLeaveMessage
  | LobbyKickMessage
  | LobbyModifyMessage
  | LobbyListMessage;

// ── server → client ─────────────────────────────────────────────────────────────────

/**
 * The full lobby, sent to every member whenever anything changes.
 *
 * Full state rather than a diff, deliberately: a lobby is a few hundred bytes and changes at
 * human speed, so the bandwidth argument for deltas (planning/02 §6) simply does not apply
 * here, and whole-state updates remove every class of "the client's copy drifted" bug.
 */
export interface LobbyStateMessage extends Envelope {
  readonly t: 'lobby.state';
  readonly lobby: LobbyState;
}

export interface LobbyListResultMessage extends Envelope {
  readonly t: 'lobby.list.result';
  readonly lobbies: readonly LobbySummary[];
}

/** You are no longer in a lobby, and here is why. */
export interface LobbyExitMessage extends Envelope {
  readonly t: 'lobby.exit';
  readonly reason: LobbyExitReason;
}

export type LobbyOp = LobbyClientMessage['t'];

export type LobbyErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'not_found'
  | 'already_in_lobby'
  | 'not_in_lobby'
  | 'not_host'
  | 'lobby_full'
  | 'team_full'
  | 'spectators_full'
  | 'rate_limited'
  | 'cannot_kick_host'
  | 'below_current_occupancy';

/**
 * A request failed. Names the operation it was answering, which is what lets the client put
 * the message on the right screen without a request-id scheme the protocol does not have.
 *
 * Distinct from the fatal `error` message: a rejection is an ordinary answer to an ordinary
 * request, and the connection stays open.
 */
export interface LobbyRejectedMessage extends Envelope {
  readonly t: 'lobby.rejected';
  readonly op: LobbyOp;
  readonly code: LobbyErrorCode;
  readonly message: string;
}

export type LobbyServerMessage =
  LobbyStateMessage | LobbyListResultMessage | LobbyExitMessage | LobbyRejectedMessage;

// ── helpers ─────────────────────────────────────────────────────────────────────────

export function createLobbyState(lobby: LobbyState): LobbyStateMessage {
  return { t: 'lobby.state', lobby };
}

export function createLobbyListResult(lobbies: readonly LobbySummary[]): LobbyListResultMessage {
  return { t: 'lobby.list.result', lobbies };
}

export function createLobbyExit(reason: LobbyExitReason): LobbyExitMessage {
  return { t: 'lobby.exit', reason };
}

export function createLobbyRejected(
  op: LobbyOp,
  code: LobbyErrorCode,
  message: string,
): LobbyRejectedMessage {
  return { t: 'lobby.rejected', op, code, message };
}
