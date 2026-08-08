/**
 * @seg/server/lobby/service — the in-memory lobby registry.
 *
 * Lobbies are **not persisted**. A server restart clears them, which is correct: a lobby has
 * no value once its members are disconnected (planning/07 §4).
 *
 * This layer owns the rules and knows nothing about sockets or messages. Everything it
 * returns is either a new `LobbyState` or a typed failure, so the handler above it does no
 * policy of its own — which is what makes the rules testable without a network.
 */

import { randomInt } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_GAME_MODE,
  FLEET_POINTS_DEFAULT,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  MAX_PLAYERS_DEFAULT,
  SPECTATOR_CAP,
  type AccountId,
  type LobbyErrorCode,
  type LobbyId,
  type LobbyListFilter,
  type LobbyMember,
  type LobbyPosition,
  type LobbySettings,
  type LobbySettingsPatch,
  type LobbyState,
  type LobbySummary,
  describeLobbySettingsProblem,
  isGameMode,
  normalizeLobbyName,
  playerCount,
  positionCount,
  spectatorCount,
  teamCapacity,
  toSummary,
  validateFleetPoints,
  validateLobbyName,
  validateMaxPlayers,
} from '@seg/shared';

// ── Results ─────────────────────────────────────────────────────────────────────────

export interface LobbyFailure {
  readonly ok: false;
  readonly code: LobbyErrorCode;
  readonly message: string;
}

export interface LobbySuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type LobbyResult<T> = LobbySuccess<T> | LobbyFailure;

function fail(code: LobbyErrorCode, message: string): LobbyFailure {
  return { ok: false, code, message };
}

function ok<T>(value: T): LobbySuccess<T> {
  return { ok: true, value };
}

/**
 * What changed, so the handler knows who to tell.
 *
 * `removed` exists because the people who need to hear about a departure are no longer in
 * `state.members` — the handler cannot work them out after the fact.
 */
export interface LobbyMutation {
  /** The lobby afterwards, or `null` if it no longer exists. */
  readonly state: LobbyState | null;
  /** Accounts that are no longer members, and why. */
  readonly removed: readonly AccountId[];
}

// ── Options ─────────────────────────────────────────────────────────────────────────

export interface LobbyServiceOptions {
  /** Injected so tests control time without sleeping (planning/13 §13). */
  readonly clock?: () => number;
  /**
   * Injected so a test can force a join-code collision, which is otherwise a 1-in-309-million
   * path that would never be exercised.
   */
  readonly generateCode?: () => string;
  /** planning/02 §7: lobby creation is rate limited. */
  readonly createCooldownMs?: number;
}

const DEFAULT_CREATE_COOLDOWN_MS = 10_000;

interface MutableLobby {
  readonly id: LobbyId;
  readonly code: string;
  hostAccountId: AccountId;
  settings: LobbySettings;
  members: LobbyMember[];
  readonly createdAt: number;
}

// ── Service ─────────────────────────────────────────────────────────────────────────

export class LobbyService {
  private readonly lobbies = new Map<LobbyId, MutableLobby>();
  /** Uppercase code → lobby id. */
  private readonly byCode = new Map<string, LobbyId>();
  /** Account → the one lobby it is in. See `already_in_lobby`. */
  private readonly membership = new Map<AccountId, LobbyId>();
  /** Account → when it last created a lobby, for the creation cooldown. */
  private readonly lastCreatedAt = new Map<AccountId, number>();

  private readonly clock: () => number;
  private readonly generateCode: () => string;
  private readonly createCooldownMs: number;

  constructor(options: LobbyServiceOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.generateCode = options.generateCode ?? defaultCodeGenerator;
    this.createCooldownMs = options.createCooldownMs ?? DEFAULT_CREATE_COOLDOWN_MS;
  }

  // ── Queries ───────────────────────────────────────────────────────────────────

  /** The lobby this account is in, or `null`. */
  lobbyFor(accountId: AccountId): LobbyState | null {
    const id = this.membership.get(accountId);
    if (id === undefined) return null;
    const lobby = this.lobbies.get(id);
    return lobby === undefined ? null : snapshot(lobby);
  }

  /**
   * The server browser. **Public lobbies only** — an unlisted lobby is never returned from
   * here, which is the whole of its unlistedness.
   *
   * Sorted by "most likely to start soon" (planning/07 §4): fullest first, because filling a
   * nearly-full lobby is the single highest-leverage thing this screen can do for a small
   * player base. Ties break on age so the order is stable between refreshes rather than
   * shuffling under the player's cursor.
   */
  list(filter: LobbyListFilter): readonly LobbySummary[] {
    const wanted = filter.name === undefined ? null : filter.name.trim().toLowerCase();

    const matches: MutableLobby[] = [];
    for (const lobby of this.lobbies.values()) {
      if (lobby.settings.visibility !== 'public') continue;
      if (filter.mode !== undefined && lobby.settings.mode !== filter.mode) continue;
      if (wanted !== null && wanted.length > 0) {
        if (!lobby.settings.name.toLowerCase().includes(wanted)) continue;
      }
      if (filter.hasOpenSlots === true) {
        if (playerCount(lobby.members) >= lobby.settings.maxPlayers) continue;
      }
      matches.push(lobby);
    }

    matches.sort((a, b) => {
      const byOccupancy = playerCount(b.members) - playerCount(a.members);
      if (byOccupancy !== 0) return byOccupancy;
      return a.createdAt - b.createdAt;
    });

    return matches.map((lobby) => toSummary(snapshot(lobby)));
  }

  // ── Commands ──────────────────────────────────────────────────────────────────

  create(accountId: AccountId, username: string, rawName: string): LobbyResult<LobbyState> {
    if (this.membership.has(accountId)) {
      return fail('already_in_lobby', 'Leave your current lobby before creating another.');
    }

    const now = this.clock();
    const last = this.lastCreatedAt.get(accountId);
    if (last !== undefined && now - last < this.createCooldownMs) {
      const seconds = Math.ceil((this.createCooldownMs - (now - last)) / 1000);
      return fail('rate_limited', `Wait ${seconds}s before creating another lobby.`);
    }

    const name = normalizeLobbyName(rawName);
    const problem = validateLobbyName(name);
    if (problem !== null) {
      return fail('validation_failed', describeLobbySettingsProblem(problem));
    }

    const code = this.mintCode();
    const id = randomUUID();

    const lobby: MutableLobby = {
      id,
      code,
      hostAccountId: accountId,
      settings: {
        name,
        maxPlayers: MAX_PLAYERS_DEFAULT,
        mode: DEFAULT_GAME_MODE,
        fleetPoints: FLEET_POINTS_DEFAULT,
        visibility: 'public',
      },
      // The host lands on team 1 rather than in the spectators: a lobby whose creator is not
      // playing reads as broken, and it would also be immediately host-migrated away on the
      // first join if they left.
      members: [
        { occupant: { kind: 'human', accountId }, username, position: 'team1', joinedAt: now },
      ],
      createdAt: now,
    };

    this.lobbies.set(id, lobby);
    this.byCode.set(code, id);
    this.membership.set(accountId, id);
    this.lastCreatedAt.set(accountId, now);

    return ok(snapshot(lobby));
  }

  joinByCode(
    accountId: AccountId,
    username: string,
    normalizedCode: string,
  ): LobbyResult<LobbyState> {
    const id = this.byCode.get(normalizedCode);
    if (id === undefined) return fail('not_found', 'No lobby has that code.');
    return this.join(accountId, username, id);
  }

  /**
   * Join a public lobby by id.
   *
   * An unlisted lobby is **not** joinable this way, and the failure is deliberately the same
   * `not_found` an unknown id gets. Returning a distinguishable error would turn the id space
   * into an oracle: anyone holding a lobby id could confirm a private lobby exists without
   * having been given the code.
   */
  joinById(accountId: AccountId, username: string, id: LobbyId): LobbyResult<LobbyState> {
    const lobby = this.lobbies.get(id);
    if (lobby === undefined || lobby.settings.visibility !== 'public') {
      return fail('not_found', 'That lobby is not open, or does not exist.');
    }
    return this.join(accountId, username, id);
  }

  private join(accountId: AccountId, username: string, id: LobbyId): LobbyResult<LobbyState> {
    const existing = this.membership.get(accountId);
    if (existing !== undefined) {
      return fail(
        'already_in_lobby',
        existing === id ? 'You are already in this lobby.' : 'Leave your current lobby first.',
      );
    }

    const lobby = this.lobbies.get(id);
    if (lobby === undefined) return fail('not_found', 'That lobby no longer exists.');

    // Joining always lands on a team if there is room, and falls back to spectating rather
    // than refusing — a full lobby you can watch is better than a door in the face.
    const position = this.firstOpenPosition(lobby);
    if (position === null) {
      return fail('lobby_full', 'That lobby is full, including its spectator slots.');
    }

    lobby.members.push({
      occupant: { kind: 'human', accountId },
      username,
      position,
      joinedAt: this.clock(),
    });
    this.membership.set(accountId, id);

    return ok(snapshot(lobby));
  }

  setPosition(accountId: AccountId, position: LobbyPosition): LobbyResult<LobbyState> {
    const lobby = this.requireLobby(accountId);
    if (lobby === null) return fail('not_in_lobby', 'You are not in a lobby.');

    const index = lobby.members.findIndex((m) => m.occupant.accountId === accountId);
    const member = lobby.members[index];
    if (member === undefined) return fail('not_in_lobby', 'You are not in a lobby.');
    if (member.position === position) return ok(snapshot(lobby));

    const capacityError = this.capacityFor(lobby, position, accountId);
    if (capacityError !== null) return capacityError;

    lobby.members[index] = { ...member, position };
    return ok(snapshot(lobby));
  }

  leave(accountId: AccountId): LobbyResult<LobbyMutation> {
    const lobby = this.requireLobby(accountId);
    if (lobby === null) return fail('not_in_lobby', 'You are not in a lobby.');
    return ok(this.remove(lobby, accountId));
  }

  kick(hostAccountId: AccountId, targetAccountId: AccountId): LobbyResult<LobbyMutation> {
    const lobby = this.requireLobby(hostAccountId);
    if (lobby === null) return fail('not_in_lobby', 'You are not in a lobby.');
    if (lobby.hostAccountId !== hostAccountId) {
      return fail('not_host', 'Only the host can kick players.');
    }
    if (targetAccountId === hostAccountId) {
      // Not merely disallowed — it is almost certainly a misclick, and the alternative
      // reading (kick yourself, triggering host migration) is what `lobby.leave` is for.
      return fail('cannot_kick_host', 'The host cannot kick themselves. Leave instead.');
    }
    if (!lobby.members.some((m) => m.occupant.accountId === targetAccountId)) {
      return fail('not_found', 'That player is not in this lobby.');
    }

    return ok(this.remove(lobby, targetAccountId));
  }

  modify(hostAccountId: AccountId, patch: LobbySettingsPatch): LobbyResult<LobbyState> {
    const lobby = this.requireLobby(hostAccountId);
    if (lobby === null) return fail('not_in_lobby', 'You are not in a lobby.');
    if (lobby.hostAccountId !== hostAccountId) {
      return fail('not_host', 'Only the host can change lobby settings.');
    }

    const next: { -readonly [K in keyof LobbySettings]: LobbySettings[K] } = {
      ...lobby.settings,
    };

    if (patch.name !== undefined) {
      const name = normalizeLobbyName(patch.name);
      const problem = validateLobbyName(name);
      if (problem !== null) return fail('validation_failed', describeLobbySettingsProblem(problem));
      next.name = name;
    }

    if (patch.maxPlayers !== undefined) {
      const problem = validateMaxPlayers(patch.maxPlayers);
      if (problem !== null) return fail('validation_failed', describeLobbySettingsProblem(problem));

      // Lowering the cap below what is already seated would mean evicting someone to satisfy
      // a settings change. Refusing is the honest answer: the host can kick first, and then
      // the shrink is something they chose rather than something that happened to them.
      const seated = playerCount(lobby.members);
      if (patch.maxPlayers < seated) {
        return fail(
          'below_current_occupancy',
          `There are already ${seated} players here. Kick someone first, or pick a higher cap.`,
        );
      }
      const perTeam = teamCapacity(patch.maxPlayers);
      const overfull = (['team1', 'team2'] as const).find(
        (team) => positionCount(lobby.members, team) > perTeam,
      );
      if (overfull !== undefined) {
        return fail(
          'below_current_occupancy',
          `That cap allows ${perTeam} per team, and one team already has more.`,
        );
      }
      next.maxPlayers = patch.maxPlayers;
    }

    if (patch.mode !== undefined) {
      if (!isGameMode(patch.mode)) {
        return fail('validation_failed', describeLobbySettingsProblem('unknown_game_mode'));
      }
      next.mode = patch.mode;
    }

    if (patch.fleetPoints !== undefined) {
      const problem = validateFleetPoints(patch.fleetPoints);
      if (problem !== null) return fail('validation_failed', describeLobbySettingsProblem(problem));
      next.fleetPoints = patch.fleetPoints;
    }

    if (patch.visibility !== undefined) {
      if (patch.visibility !== 'public' && patch.visibility !== 'unlisted') {
        return fail('validation_failed', 'Visibility must be public or unlisted.');
      }
      next.visibility = patch.visibility;
    }

    lobby.settings = next;
    return ok(snapshot(lobby));
  }

  /** Called when a connection drops. Same as leaving; a lobby has no reconnect window. */
  disconnect(accountId: AccountId): LobbyMutation | null {
    const lobby = this.requireLobby(accountId);
    if (lobby === null) return null;
    return this.remove(lobby, accountId);
  }

  // ── Internals ─────────────────────────────────────────────────────────────────

  private requireLobby(accountId: AccountId): MutableLobby | null {
    const id = this.membership.get(accountId);
    if (id === undefined) return null;
    return this.lobbies.get(id) ?? null;
  }

  private remove(lobby: MutableLobby, accountId: AccountId): LobbyMutation {
    lobby.members = lobby.members.filter((m) => m.occupant.accountId !== accountId);
    this.membership.delete(accountId);

    if (lobby.members.length === 0) {
      this.lobbies.delete(lobby.id);
      this.byCode.delete(lobby.code);
      return { state: null, removed: [accountId] };
    }

    if (lobby.hostAccountId === accountId) {
      // Host migration: the longest-connected remaining member inherits (planning/07 §4).
      // Players before spectators — handing the lobby to someone who is not playing would
      // leave nobody able to start it.
      const candidates = [...lobby.members].sort((a, b) => {
        const aSpec = a.position === 'spectator' ? 1 : 0;
        const bSpec = b.position === 'spectator' ? 1 : 0;
        if (aSpec !== bSpec) return aSpec - bSpec;
        return a.joinedAt - b.joinedAt;
      });
      const heir = candidates[0];
      if (heir !== undefined) lobby.hostAccountId = heir.occupant.accountId;
    }

    return { state: snapshot(lobby), removed: [accountId] };
  }

  /** The position a joiner should land in, or `null` when there is nowhere to put them. */
  private firstOpenPosition(lobby: MutableLobby): LobbyPosition | null {
    const perTeam = teamCapacity(lobby.settings.maxPlayers);
    const team1 = positionCount(lobby.members, 'team1');
    const team2 = positionCount(lobby.members, 'team2');

    // Smaller team first, so joins self-balance without an auto-balance setting.
    if (team1 <= team2 && team1 < perTeam) return 'team1';
    if (team2 < perTeam) return 'team2';
    if (team1 < perTeam) return 'team1';
    if (spectatorCount(lobby.members) < SPECTATOR_CAP) return 'spectator';
    return null;
  }

  /** `null` when `position` has room for `accountId`, otherwise the failure to return. */
  private capacityFor(
    lobby: MutableLobby,
    position: LobbyPosition,
    accountId: AccountId,
  ): LobbyFailure | null {
    const others = lobby.members.filter((m) => m.occupant.accountId !== accountId);

    if (position === 'spectator') {
      if (spectatorCount(others) >= SPECTATOR_CAP) {
        return fail('spectators_full', 'There is no spectator slot free.');
      }
      return null;
    }

    if (positionCount(others, position) >= teamCapacity(lobby.settings.maxPlayers)) {
      return fail('team_full', 'That team is full.');
    }
    return null;
  }

  private mintCode(): string {
    // Bounded rather than `while (true)`: at 26^6 codes a collision is already implausible,
    // and a generator that somehow returns a constant should surface as an error rather than
    // hang the server in a spin loop.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = this.generateCode();
      if (!this.byCode.has(code)) return code;
    }
    throw new Error('could not mint a unique join code in 100 attempts');
  }
}

/** Uniform over the shared alphabet, from a CSPRNG — a guessable code is an open door. */
function defaultCodeGenerator(): string {
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i += 1) {
    code += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

/** A frozen copy, so a caller holding a state cannot mutate the registry through it. */
function snapshot(lobby: MutableLobby): LobbyState {
  return {
    id: lobby.id,
    code: lobby.code,
    hostAccountId: lobby.hostAccountId,
    settings: { ...lobby.settings },
    members: lobby.members.map((m) => ({ ...m })),
    createdAt: lobby.createdAt,
  };
}
