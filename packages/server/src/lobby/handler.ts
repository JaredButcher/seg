/**
 * @seg/server/lobby/handler — lobby commands over the game protocol.
 *
 * Every message here arrives on the `control` channel and therefore over the WebSocket,
 * permanently (planning/02 §3.1, ADR 0001).
 *
 * The split with `service.ts` is deliberate: the service owns the rules and returns typed
 * results, this file owns the protocol and decides who hears about a change. No rule is
 * enforced in both places, so there is nowhere for the two to disagree.
 */

import {
  createLobbyExit,
  createLobbyListResult,
  createLobbyRejected,
  createLobbyState,
  isGameMode,
  isLobbyPosition,
  normalizeJoinCode,
  validateJoinCode,
  describeJoinCodeProblem,
  type AccountId,
  type LobbyClientMessage,
  type LobbyExitReason,
  type LobbyListFilter,
  type LobbyOp,
  type LobbySettingsPatch,
  type LobbyState,
  type Message,
  type ServerMessage,
} from '@seg/shared';

import type { LobbyMutation, LobbyResult, LobbyService } from './service.js';

/**
 * One authenticated player's connection.
 *
 * Identity is supplied by whatever owns the socket — the handler never derives it from the
 * message, because a client that can name its own account id can act as anyone.
 */
export interface LobbyConnection {
  readonly accountId: AccountId;
  readonly username: string;
  send(message: ServerMessage): void;
}

const LOBBY_OPS = new Set<string>([
  'lobby.create',
  'lobby.join',
  'lobby.setPosition',
  'lobby.leave',
  'lobby.kick',
  'lobby.modify',
  'lobby.list',
]);

/** Whether this handler is the one that should answer a given message. */
export function isLobbyMessage(msg: Message): msg is LobbyClientMessage {
  return LOBBY_OPS.has(msg.t);
}

export class LobbyHandler {
  /** Connected accounts, so a change can be pushed to the other members of a lobby. */
  private readonly connections = new Map<AccountId, LobbyConnection>();

  constructor(private readonly service: LobbyService) {}

  // ── Connection lifecycle ──────────────────────────────────────────────────────

  attach(connection: LobbyConnection): void {
    this.connections.set(connection.accountId, connection);
  }

  /**
   * A socket dropped. The player leaves any lobby they were in.
   *
   * No grace period, deliberately: the 90 s reconnect window (Q21) is a *match* affordance,
   * and holding a lobby slot for someone who closed their tab is how lobbies fill up with
   * ghosts that nobody can kick.
   */
  detach(accountId: AccountId): void {
    this.connections.delete(accountId);
    const mutation = this.service.disconnect(accountId);
    if (mutation !== null) this.broadcast(mutation.state);
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────────

  handle(connection: LobbyConnection, msg: LobbyClientMessage): void {
    switch (msg.t) {
      case 'lobby.create':
        this.settle(
          connection,
          msg.t,
          this.service.create(
            connection.accountId,
            connection.username,
            typeof msg.name === 'string' ? msg.name : '',
          ),
        );
        return;

      case 'lobby.join':
        this.join(connection, msg.target);
        return;

      case 'lobby.setPosition':
        if (!isLobbyPosition(msg.position)) {
          this.reject(connection, msg.t, 'bad_request', 'That is not a lobby position.');
          return;
        }
        this.settle(
          connection,
          msg.t,
          this.service.setPosition(connection.accountId, msg.position),
        );
        return;

      case 'lobby.leave':
        this.exit(connection, msg.t, this.service.leave(connection.accountId), 'left');
        return;

      case 'lobby.kick': {
        if (typeof msg.accountId !== 'string' || msg.accountId.length === 0) {
          this.reject(connection, msg.t, 'bad_request', 'A player id is required.');
          return;
        }
        const result = this.service.kick(connection.accountId, msg.accountId);
        if (!result.ok) {
          this.reject(connection, msg.t, result.code, result.message);
          return;
        }
        // The kicked player is told directly; everyone still present gets the new state.
        this.tell(msg.accountId, createLobbyExit('kicked'));
        this.broadcast(result.value.state);
        return;
      }

      case 'lobby.modify': {
        const patch = readPatch(msg.patch);
        if (patch === null) {
          this.reject(connection, msg.t, 'bad_request', 'Malformed settings change.');
          return;
        }
        this.settle(connection, msg.t, this.service.modify(connection.accountId, patch));
        return;
      }

      case 'lobby.list':
        connection.send(createLobbyListResult(this.service.list(readFilter(msg.filter))));
        return;
    }
  }

  // ── Outcomes ──────────────────────────────────────────────────────────────────

  /** A command that leaves the caller in the lobby: everyone present sees the new state. */
  private settle(connection: LobbyConnection, op: LobbyOp, result: LobbyResult<LobbyState>): void {
    if (!result.ok) {
      this.reject(connection, op, result.code, result.message);
      return;
    }
    this.broadcast(result.value);
  }

  /** A command that removes the caller: they get an exit, the rest get the new state. */
  private exit(
    connection: LobbyConnection,
    op: LobbyOp,
    result: LobbyResult<LobbyMutation>,
    reason: LobbyExitReason,
  ): void {
    if (!result.ok) {
      this.reject(connection, op, result.code, result.message);
      return;
    }
    connection.send(createLobbyExit(reason));
    this.broadcast(result.value.state);
  }

  private join(connection: LobbyConnection, target: unknown): void {
    if (typeof target !== 'object' || target === null || !('by' in target)) {
      this.reject(connection, 'lobby.join', 'bad_request', 'A lobby code or id is required.');
      return;
    }

    const by = (target as { by: unknown }).by;

    if (by === 'code') {
      const raw = (target as { code?: unknown }).code;
      if (typeof raw !== 'string') {
        this.reject(connection, 'lobby.join', 'bad_request', 'A join code is required.');
        return;
      }
      // Normalize before validating, so a pasted "bcd-fgh" is the code it obviously is.
      const code = normalizeJoinCode(raw);
      const problem = validateJoinCode(code);
      if (problem !== null) {
        this.reject(
          connection,
          'lobby.join',
          'validation_failed',
          describeJoinCodeProblem(problem),
        );
        return;
      }
      this.settle(
        connection,
        'lobby.join',
        this.service.joinByCode(connection.accountId, connection.username, code),
      );
      return;
    }

    if (by === 'id') {
      const lobbyId = (target as { lobbyId?: unknown }).lobbyId;
      if (typeof lobbyId !== 'string' || lobbyId.length === 0) {
        this.reject(connection, 'lobby.join', 'bad_request', 'A lobby id is required.');
        return;
      }
      this.settle(
        connection,
        'lobby.join',
        this.service.joinById(connection.accountId, connection.username, lobbyId),
      );
      return;
    }

    this.reject(connection, 'lobby.join', 'bad_request', 'A lobby code or id is required.');
  }

  private reject(
    connection: LobbyConnection,
    op: LobbyOp,
    code: Parameters<typeof createLobbyRejected>[1],
    message: string,
  ): void {
    connection.send(createLobbyRejected(op, code, message));
  }

  /**
   * Push the whole lobby to everyone in it.
   *
   * `state` is `null` when the last member left and the lobby is gone — there is nobody to
   * tell, which is why this is not an error case.
   */
  private broadcast(state: LobbyState | null): void {
    if (state === null) return;
    const message = createLobbyState(state);
    for (const member of state.members) {
      this.tell(member.occupant.accountId, message);
    }
  }

  private tell(accountId: AccountId, message: ServerMessage): void {
    this.connections.get(accountId)?.send(message);
  }
}

// ── Inbound shape checks ────────────────────────────────────────────────────────────

/**
 * These read untrusted input off the wire, so every field is checked rather than cast.
 *
 * An unknown or wrong-typed field is dropped rather than rejected: `lobby.modify` is a patch,
 * and the alternative — failing the whole request because a future client sent one field this
 * server does not know — makes every protocol addition a breaking change.
 */
function readPatch(raw: unknown): LobbySettingsPatch | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const input = raw as Record<string, unknown>;
  const patch: {
    -readonly [K in keyof LobbySettingsPatch]: LobbySettingsPatch[K];
  } = {};

  if (typeof input['name'] === 'string') patch.name = input['name'];
  if (typeof input['maxPlayers'] === 'number') patch.maxPlayers = input['maxPlayers'];
  if (typeof input['fleetPoints'] === 'number') patch.fleetPoints = input['fleetPoints'];
  if (isGameMode(input['mode'])) patch.mode = input['mode'];
  if (input['visibility'] === 'public' || input['visibility'] === 'unlisted') {
    patch.visibility = input['visibility'];
  }

  return patch;
}

function readFilter(raw: unknown): LobbyListFilter {
  if (typeof raw !== 'object' || raw === null) return {};
  const input = raw as Record<string, unknown>;
  const filter: { -readonly [K in keyof LobbyListFilter]: LobbyListFilter[K] } = {};

  if (typeof input['name'] === 'string') filter.name = input['name'];
  if (typeof input['hasOpenSlots'] === 'boolean') filter.hasOpenSlots = input['hasOpenSlots'];
  if (isGameMode(input['mode'])) filter.mode = input['mode'];

  return filter;
}
