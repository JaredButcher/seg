/**
 * @seg/shared/protocol/lobby — the lobby wire messages.
 *
 * **Every message here travels on the `control` channel, which is pinned to the WebSocket
 * permanently** (planning/02 §3.1, ADR 0001). That is not an implementation accident: lobby
 * traffic happens before a match exists and therefore before there is anything to negotiate
 * a data channel for, and it needs reliable ordered delivery — a dropped `lobby.join` is a
 * player staring at a screen that did not change.
 */

import type { FleetId } from '../fleet/types.js';
import type {
  AccountId,
  LobbyExitReason,
  LobbyId,
  LobbyListFilter,
  LobbySelfView,
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

/**
 * Bring a fleet into this lobby, or `null` to bring none.
 *
 * Only the id crosses the wire. The server reads the fleet from the account it already knows
 * the caller owns, so a client cannot describe a fleet it does not have or understate what one
 * costs — the point budget would be advisory otherwise.
 */
export interface LobbySelectFleetMessage extends Envelope {
  readonly t: 'lobby.selectFleet';
  readonly fleetId: FleetId | null;
}

/** Toggle your own readiness. Requires a selected fleet to turn on. */
export interface LobbySetReadyMessage extends Envelope {
  readonly t: 'lobby.setReady';
  readonly ready: boolean;
}

/** Host only, and only once every player is ready. */
export interface LobbyStartMessage extends Envelope {
  readonly t: 'lobby.start';
}

export type LobbyClientMessage =
  | LobbyCreateMessage
  | LobbyJoinMessage
  | LobbySetPositionMessage
  | LobbyLeaveMessage
  | LobbyKickMessage
  | LobbyModifyMessage
  | LobbyListMessage
  | LobbySelectFleetMessage
  | LobbySetReadyMessage
  | LobbyStartMessage;

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
  /**
   * The recipient's own private slice — currently just which fleet they brought.
   *
   * This message is therefore built per recipient rather than once per broadcast. That is the
   * whole enforcement of "other players can see *that* you picked a fleet, not *which*": the
   * detail is never in the shared object, so there is no client-side filtering to forget and
   * no devtools inspection that reveals it.
   */
  readonly you: LobbySelfView;
}

export interface LobbyListResultMessage extends Envelope {
  readonly t: 'lobby.list.result';
  readonly lobbies: readonly LobbySummary[];
  /**
   * Accounts currently connected, whether or not they are in a lobby.
   *
   * Carried with the list because of what an empty list means without it. planning/07 §4:
   * "An empty browser with '0 players online' is honest; an empty browser with no context
   * reads as broken." With no matchmaking and a small player base (risk R4) this screen has
   * to be able to tell those two apart.
   */
  readonly playersOnline: number;
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
  | 'below_current_occupancy'
  | 'no_fleet_selected'
  | 'fleet_over_budget'
  | 'spectator_cannot_ready'
  | 'not_all_ready'
  /** The request was legal and authorized; the feature behind it does not exist yet. */
  | 'not_implemented'
  /**
   * The start was legal and authorized, and the server has no room to run another match.
   *
   * One worker thread per match, capped by `SEG_MAX_MATCHES` (`server/match/worker/pool.ts`).
   * Distinct from `internal_error` because nothing went wrong and distinct from `not_implemented`
   * because nothing is missing: the only useful thing a client can do with it is say so and offer
   * to try again, which is why it is worth its own code rather than a generic failure.
   */
  | 'at_capacity'
  /** The server could not do what it agreed to do. Rare, and never the client's fault. */
  | 'internal_error';

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

export function createLobbyState(lobby: LobbyState, you: LobbySelfView): LobbyStateMessage {
  return { t: 'lobby.state', lobby, you };
}

export function createLobbyListResult(
  lobbies: readonly LobbySummary[],
  playersOnline: number,
): LobbyListResultMessage {
  return { t: 'lobby.list.result', lobbies, playersOnline };
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
