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
  isMapSize,
  isMapType,
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
  type SelectedFleet,
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

/**
 * Resolves one of an account's saved fleets into the summary a lobby needs.
 *
 * Injected rather than imported so this file keeps knowing nothing about storage, and so the
 * lookup is the only place ownership is proved. It returns `null` both for "no such fleet" and
 * for "not yours" — a caller must not be able to tell those apart, or fleet ids become an
 * oracle for what other accounts own.
 */
export type LobbyFleetLookup = (
  accountId: AccountId,
  fleetId: string,
) => Promise<SelectedFleet | null>;

export interface LobbyHandlerOptions {
  readonly fleets?: LobbyFleetLookup;
}

const LOBBY_OPS = new Set<string>([
  'lobby.create',
  'lobby.join',
  'lobby.setPosition',
  'lobby.leave',
  'lobby.kick',
  'lobby.modify',
  'lobby.list',
  'lobby.selectFleet',
  'lobby.setReady',
  'lobby.start',
]);

/** Whether this handler is the one that should answer a given message. */
export function isLobbyMessage(msg: Message): msg is LobbyClientMessage {
  return LOBBY_OPS.has(msg.t);
}

export class LobbyHandler {
  /** Connected accounts, so a change can be pushed to the other members of a lobby. */
  private readonly connections = new Map<AccountId, LobbyConnection>();
  private readonly fleets: LobbyFleetLookup | undefined;

  constructor(
    private readonly service: LobbyService,
    options: LobbyHandlerOptions = {},
  ) {
    this.fleets = options.fleets;
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────────

  /**
   * Register a connection, and immediately tell it about the lobby it is already in.
   *
   * That second half is not optional. Membership lives on the account, not on the socket, so
   * a fresh connection for an account that is already in a lobby has no way to discover that
   * — it would sit on the main menu while the server considers it seated, and every
   * subsequent create or join would be refused with `already_in_lobby` with nothing on
   * screen explaining why. This is the state-recovery path for a replaced tab and, later,
   * for a genuine reconnect.
   */
  attach(connection: LobbyConnection): void {
    this.connections.set(connection.accountId, connection);

    const existing = this.service.lobbyFor(connection.accountId);
    if (existing !== null) {
      connection.send(createLobbyState(existing, this.service.viewFor(connection.accountId)));
    }
  }

  /**
   * A saved fleet was written or deleted, so any lobby selection naming it may be stale.
   *
   * Called by the fleet routes. Nothing happens unless the account is in a lobby and has that
   * exact fleet selected, which is the common case by a wide margin — a player editing fleets
   * from the main menu costs one map lookup.
   */
  fleetChanged(accountId: AccountId, fleetId: string): void {
    if (this.service.lobbyFor(accountId) === null) return;

    void (async () => {
      const fleet = this.fleets === undefined ? null : await this.fleets(accountId, fleetId);
      this.broadcast(this.service.resyncFleet(accountId, fleet, fleetId));
    })().catch(() => {
      // A failed re-read must not take down the write that triggered it. The selection stays
      // as it was and is re-checked when the host starts the match.
    });
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
        connection.send(
          createLobbyListResult(
            this.service.list(readFilter(msg.filter)),
            // The attached connections *are* the players online: one socket per account
            // (see the gateway), so this map's size is the count without extra bookkeeping.
            this.connections.size,
          ),
        );
        return;

      case 'lobby.selectFleet':
        this.selectFleet(connection, msg.fleetId);
        return;

      case 'lobby.setReady':
        if (typeof msg.ready !== 'boolean') {
          this.reject(connection, msg.t, 'bad_request', 'Ready must be true or false.');
          return;
        }
        this.settle(connection, msg.t, this.service.setReady(connection.accountId, msg.ready));
        return;

      case 'lobby.start': {
        const result = this.service.start(connection.accountId);
        if (!result.ok) {
          this.reject(connection, msg.t, result.code, result.message);
          return;
        }
        // Authorized, and there is nothing to authorize it *into* yet. Saying so is better
        // than a button that silently does nothing; when the match runtime lands, this line
        // becomes the call that creates one and the checks above stay exactly as they are.
        this.reject(
          connection,
          msg.t,
          'not_implemented',
          'Everyone is ready. Match start is not wired up yet.',
        );
        return;
      }
    }
  }

  /**
   * Resolve a fleet id against the caller's own account, then hand the summary to the service.
   *
   * The lookup is the only asynchronous step in this handler. A player who leaves while it is
   * in flight simply gets `not_in_lobby` from the service afterwards, which is the truth.
   */
  private selectFleet(connection: LobbyConnection, fleetId: unknown): void {
    if (fleetId === null) {
      this.settle(
        connection,
        'lobby.selectFleet',
        this.service.selectFleet(connection.accountId, null),
      );
      return;
    }
    if (typeof fleetId !== 'string' || fleetId.length === 0) {
      this.reject(connection, 'lobby.selectFleet', 'bad_request', 'A fleet id is required.');
      return;
    }
    if (this.fleets === undefined) {
      this.reject(
        connection,
        'lobby.selectFleet',
        'not_implemented',
        'This server cannot read saved fleets.',
      );
      return;
    }

    void this.fleets(connection.accountId, fleetId)
      .then((fleet) => {
        if (fleet === null) {
          this.reject(connection, 'lobby.selectFleet', 'not_found', 'No such fleet.');
          return;
        }
        this.settle(
          connection,
          'lobby.selectFleet',
          this.service.selectFleet(connection.accountId, fleet),
        );
      })
      .catch(() => {
        this.reject(
          connection,
          'lobby.selectFleet',
          'bad_request',
          'Could not read that fleet. Try again.',
        );
      });
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
   * A separate message per member, not one shared object: each carries that member's own
   * private view (which fleet they brought), and building it here is what guarantees a
   * player's fleet is only ever addressed to them.
   *
   * `state` is `null` when the last member left and the lobby is gone — there is nobody to
   * tell, which is why this is not an error case.
   */
  private broadcast(state: LobbyState | null): void {
    if (state === null) return;
    for (const member of state.members) {
      const accountId = member.occupant.accountId;
      this.tell(accountId, createLobbyState(state, this.service.viewFor(accountId)));
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
  if (isMapType(input['mapType'])) patch.mapType = input['mapType'];
  if (isMapSize(input['mapSize'])) patch.mapSize = input['mapSize'];

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
