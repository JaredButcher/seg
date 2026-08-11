/**
 * The lobby shapes that cross the wire. Both sides import these, so the server browser and
 * the lobby screen cannot drift from what the server actually sends.
 *
 * planning/07 §4.
 */

import type { FleetId } from '../fleet/types.js';
import type { GameMode, LobbyPosition, MapSize, MapType } from './settings.js';

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
  readonly mapType: MapType;
  readonly mapSize: MapSize;
  /**
   * Whether the match this lobby starts answers to the browser-console debug commands
   * (`protocol/debug.ts`): toggling a player's own fog of war, and spawning subs and torpedoes.
   * Off by default — this is a testing affordance, not something a normal match should carry —
   * and the server refuses every `debug.*` message on a match that did not start with it set,
   * so a client cannot turn it on after the fact by fabricating one.
   */
  readonly debugMode: boolean;
}

/** A modify request. Every field optional; absent means "leave it alone". */
export interface LobbySettingsPatch {
  readonly name?: string;
  readonly maxPlayers?: number;
  readonly mode?: GameMode;
  readonly fleetPoints?: number;
  readonly visibility?: LobbyVisibility;
  readonly mapType?: MapType;
  readonly mapSize?: MapSize;
  readonly debugMode?: boolean;
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
  /**
   * Whether this member has picked a fleet — and **only** whether.
   *
   * Which fleet, and what is in it, is private: an opponent who could read the roster before
   * the match would know the hull count and point split of everything they are about to hunt,
   * which is most of what sonar is supposed to make them work for (planning/06 §3). The
   * owner gets the detail through `LobbySelfView`, which is addressed to them alone.
   */
  readonly hasFleet: boolean;
  readonly ready: boolean;
}

/**
 * The fleet a member brought, summarised. Sent only to the member it belongs to.
 *
 * A summary rather than the fleet itself: the lobby needs a name to show and a point value to
 * check against the budget, and nothing here has any business knowing what a module is.
 */
export interface SelectedFleet {
  readonly id: FleetId;
  readonly name: string;
  readonly boatCount: number;
  readonly points: number;
}

/**
 * The part of a lobby update that differs per recipient.
 *
 * Carried alongside the shared `LobbyState` rather than in a message of its own, so a client
 * can never render a roster against a stale view of its own selection. Cross-message ordering
 * is explicitly not guaranteed by the protocol (planning/02 §3.3) — a private detail that must
 * agree with a public snapshot therefore has to travel with it.
 */
export interface LobbySelfView {
  readonly fleet: SelectedFleet | null;
}

export const NO_SELF_VIEW: LobbySelfView = { fleet: null };

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

/**
 * Seating queries.
 *
 * Typed against the one field they read rather than against `LobbyMember`, so the server's
 * mutable member record — which carries the private fleet selection these must never see —
 * can be counted without first being converted into a wire shape.
 */
type Seated = { readonly position: LobbyPosition };

/** Player slots in use. Spectators are counted separately and never against `maxPlayers`. */
export function playerCount(members: readonly Seated[]): number {
  return members.filter((m) => m.position !== 'spectator').length;
}

export function spectatorCount(members: readonly Seated[]): number {
  return members.filter((m) => m.position === 'spectator').length;
}

export function positionCount(members: readonly Seated[], position: LobbyPosition): number {
  return members.filter((m) => m.position === position).length;
}

// ── readiness ───────────────────────────────────────────────────────────────────────

type Readiable = Seated & { readonly ready: boolean };

/**
 * Whether everyone who is going to play has said they are ready.
 *
 * Spectators are excluded from both halves: they field no boats, so waiting on them would let
 * anyone hold a lobby hostage by watching. The empty case is `false` rather than vacuously
 * true — a lobby with nobody on a team has nothing to start.
 *
 * Shared so the host's Start button and the server's authorization answer the same question.
 * The button is a convenience; `LobbyService.start` is the decision.
 */
export function everyoneReady(members: readonly Readiable[]): boolean {
  const players = members.filter((m) => m.position !== 'spectator');
  return players.length > 0 && players.every((m) => m.ready);
}

export function readyCount(members: readonly Readiable[]): number {
  return members.filter((m) => m.position !== 'spectator' && m.ready).length;
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
