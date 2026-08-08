/**
 * The lobby shapes that cross the wire. Both sides import these, so the server browser and
 * the lobby screen cannot drift from what the server actually sends.
 *
 * planning/07 §4.
 */

import type { GameMode, LobbyPosition } from './settings.js';

export type LobbyId = string;
export type AccountId = string;

/**
 * `public` lobbies appear in the browser and can be joined by id; `unlisted` ones can only
 * be joined with the code (planning/06 §3).
 *
 * The two together are what make "code for private, id for public" a real privacy property
 * rather than a UI convention — see `LobbyJoinTarget`.
 */
export type LobbyVisibility = 'public' | 'unlisted';

/** The host-configurable settings this milestone covers. Full table in planning/06 §3. */
export interface LobbySettings {
  readonly name: string;
  readonly maxPlayers: number;
  readonly mode: GameMode;
  readonly fleetPoints: number;
  readonly visibility: LobbyVisibility;
}

/** A modify request. Every field optional; absent means "leave it alone". */
export interface LobbySettingsPatch {
  readonly name?: string;
  readonly maxPlayers?: number;
  readonly mode?: GameMode;
  readonly fleetPoints?: number;
  readonly visibility?: LobbyVisibility;
}

/**
 * One occupant of a lobby.
 *
 * Modelled as a generic occupant with a `kind`, not specifically a human account
 * (planning/07 §4). Bots are out of scope for 1.0 (C3), but shaping it as a tagged union
 * now means adding a `'bot'` occupant later is a UI change rather than a data migration.
 */
export type LobbyOccupant = { readonly kind: 'human'; readonly accountId: AccountId };

export interface LobbyMember {
  readonly occupant: LobbyOccupant;
  readonly username: string;
  readonly position: LobbyPosition;
  /** Epoch ms. Drives host migration — the longest-connected player inherits (planning/07 §4). */
  readonly joinedAt: number;
}

/** The full picture, sent to members of a lobby only. */
export interface LobbyState {
  readonly id: LobbyId;
  /**
   * The join code. **Members only.** It is the shared secret that admits someone to an
   * unlisted lobby, so it never appears in a `LobbySummary` and never reaches the browser.
   */
  readonly code: string;
  readonly hostAccountId: AccountId;
  readonly settings: LobbySettings;
  readonly members: readonly LobbyMember[];
  readonly createdAt: number;
}

/**
 * One row in the server browser. Exactly the fields a player needs to choose a lobby, and
 * deliberately not one more — no code, no member list, no host account id.
 */
export interface LobbySummary {
  readonly id: LobbyId;
  readonly name: string;
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly mode: GameMode;
  readonly fleetPoints: number;
}

/** Filters for the server browser. All optional; omitted means "do not filter on this". */
export interface LobbyListFilter {
  /** Case-insensitive substring match on the lobby name. */
  readonly name?: string;
  /** When true, only lobbies with at least one free player slot. */
  readonly hasOpenSlots?: boolean;
  readonly mode?: GameMode;
}

/** How a player came to leave a lobby. Drives what the client says on the way out. */
export type LobbyExitReason = 'left' | 'kicked' | 'closed';

/** Player slots in use. Spectators are counted separately and never against `maxPlayers`. */
export function playerCount(members: readonly LobbyMember[]): number {
  return members.filter((m) => m.position !== 'spectator').length;
}

export function spectatorCount(members: readonly LobbyMember[]): number {
  return members.filter((m) => m.position === 'spectator').length;
}

export function positionCount(members: readonly LobbyMember[], position: LobbyPosition): number {
  return members.filter((m) => m.position === position).length;
}

/** The browser row for a lobby. The narrowing is the point — see `LobbySummary`. */
export function toSummary(state: LobbyState): LobbySummary {
  return {
    id: state.id,
    name: state.settings.name,
    playerCount: playerCount(state.members),
    maxPlayers: state.settings.maxPlayers,
    mode: state.settings.mode,
    fleetPoints: state.settings.fleetPoints,
  };
}
