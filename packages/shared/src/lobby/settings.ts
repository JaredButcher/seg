/**
 * Lobby settings and their rules — the single source of truth for both sides.
 *
 * The client validates a form before sending; the server enforces the same functions and
 * never trusts the client. Same reasoning as ../auth/validation.ts.
 *
 * Values come from planning/06 §3 and planning/07 §4.
 */

// ── Game modes ──────────────────────────────────────────────────────────────────────

/** planning/06 §2. Objective Capture is the default and the mode a new player sees first. */
export const GAME_MODES = ['objective-capture', 'deathmatch'] as const;
export type GameMode = (typeof GAME_MODES)[number];

export const DEFAULT_GAME_MODE: GameMode = 'objective-capture';

export function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && (GAME_MODES as readonly string[]).includes(value);
}

/** Player-facing label. Kept beside the ids so the two cannot drift. */
export function describeGameMode(mode: GameMode): string {
  switch (mode) {
    case 'objective-capture':
      return 'Objective Capture';
    case 'deathmatch':
      return 'Deathmatch';
  }
}

// ── Map ──────────────────────────────────────────────────────────────────────────

/**
 * What terrain a match is fought over (planning/14 §1).
 *
 * `dense` is the original base game — procedural obstacle fields packed into the lane.
 * `empty` and `sparse` are flatter variants that trade cover for line of sight, so the
 * three describe the same world at different clutter levels, not different biomes.
 */
export const MAP_TYPES = ['empty', 'sparse', 'dense'] as const;
export type MapType = (typeof MAP_TYPES)[number];

/** The default is the base game: dense terrain (planning/14 §1). */
export const DEFAULT_MAP_TYPE: MapType = 'dense';

export function isMapType(value: unknown): value is MapType {
  return typeof value === 'string' && (MAP_TYPES as readonly string[]).includes(value);
}

/** Player-facing label. Kept beside the ids so the two cannot drift. */
export function describeMapType(type: MapType): string {
  switch (type) {
    case 'empty':
      return 'Empty';
    case 'sparse':
      return 'Sparse';
    case 'dense':
      return 'Dense';
  }
}

/**
 * Relative extent of the map. Exact dimensions are deliberately not pinned here —
 * planning/14 §1 records sizes as a scale against the base map rather than fixed
 * numbers, so the map-generation milestone can tune them without a protocol change.
 */
export const MAP_SIZES = ['small', 'medium', 'large'] as const;
export type MapSize = (typeof MAP_SIZES)[number];

/** The base map's dimensions are the `medium` scale (planning/14 §1). */
export const DEFAULT_MAP_SIZE: MapSize = 'medium';

export function isMapSize(value: unknown): value is MapSize {
  return typeof value === 'string' && (MAP_SIZES as readonly string[]).includes(value);
}

/** Player-facing label. Kept beside the ids so the two cannot drift. */
export function describeMapSize(size: MapSize): string {
  switch (size) {
    case 'small':
      return 'Small';
    case 'medium':
      return 'Medium';
    case 'large':
      return 'Large';
  }
}

// ── Positions ───────────────────────────────────────────────────────────────────────

/**
 * Where a member sits. Two teams plus spectators (planning/06 §3, 07 §5).
 *
 * `team1`/`team2` rather than a numeric TeamId because this is the wire and the UI
 * vocabulary; the simulation's `TeamId` (0/1) is an internal detail that the lobby has no
 * reason to leak.
 */
export const LOBBY_POSITIONS = ['team1', 'team2', 'spectator'] as const;
export type LobbyPosition = (typeof LOBBY_POSITIONS)[number];

export function isLobbyPosition(value: unknown): value is LobbyPosition {
  return typeof value === 'string' && (LOBBY_POSITIONS as readonly string[]).includes(value);
}

export const TEAM_POSITIONS: readonly LobbyPosition[] = ['team1', 'team2'];

// ── Numeric bounds ──────────────────────────────────────────────────────────────────

export const LOBBY_NAME_MIN_LENGTH = 3;
export const LOBBY_NAME_MAX_LENGTH = 32;

/**
 * Total player slots across both teams: 1v1 through 8v8 (planning/06 §3).
 *
 * Constrained to even numbers so the per-team capacity is exactly `maxPlayers / 2` with no
 * rounding rule to remember. An odd cap would mean one team is permanently larger, which is
 * not a lobby setting anyone wants.
 */
export const MAX_PLAYERS_MIN = 2;
export const MAX_PLAYERS_MAX = 16;
/** 3v3, the case everything is tuned for (planning/00 §4). */
export const MAX_PLAYERS_DEFAULT = 6;

export const FLEET_POINTS_MIN = 200;
export const FLEET_POINTS_MAX = 1500;
export const FLEET_POINTS_DEFAULT = 500;

/** Debug commands are off unless the host turns them on for this lobby. */
export const DEFAULT_DEBUG_MODE = false;

/** planning/07 §5. Each spectator costs a view stream, so the cap is real, not cosmetic. */
export const SPECTATOR_CAP = 16;

/** Per-team capacity implied by the total cap. */
export function teamCapacity(maxPlayers: number): number {
  return maxPlayers / 2;
}

// ── Validation ──────────────────────────────────────────────────────────────────────

export type LobbySettingsProblem =
  | 'name_too_short'
  | 'name_too_long'
  | 'name_invalid_characters'
  | 'max_players_out_of_range'
  | 'max_players_odd'
  | 'fleet_points_out_of_range'
  | 'unknown_game_mode'
  | 'unknown_map_type'
  | 'unknown_map_size';

/**
 * Lobby names are user-generated content, and 1.0 ships with no moderation tooling
 * (planning/01 §8). The answer there is to keep the surface small: length-capped and
 * character-restricted, so the worst case is a rude ASCII string rather than
 * right-to-left overrides, zero-width joiners, or homoglyph impersonation of another
 * player in the server browser.
 */
const LOBBY_NAME_PATTERN = /^[A-Za-z0-9 '\-_.!?]+$/;

/**
 * Trims, and collapses internal runs of whitespace to one space.
 *
 * The collapse matters for the server browser specifically: without it, `"a          b"`
 * renders as a name that pushes every other column off the row.
 */
export function normalizeLobbyName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Validates an already-normalized name. */
export function validateLobbyName(name: string): LobbySettingsProblem | null {
  if (name.length < LOBBY_NAME_MIN_LENGTH) return 'name_too_short';
  if (name.length > LOBBY_NAME_MAX_LENGTH) return 'name_too_long';
  if (!LOBBY_NAME_PATTERN.test(name)) return 'name_invalid_characters';
  return null;
}

export function validateMaxPlayers(maxPlayers: number): LobbySettingsProblem | null {
  if (!Number.isInteger(maxPlayers)) return 'max_players_out_of_range';
  if (maxPlayers < MAX_PLAYERS_MIN || maxPlayers > MAX_PLAYERS_MAX) {
    return 'max_players_out_of_range';
  }
  if (maxPlayers % 2 !== 0) return 'max_players_odd';
  return null;
}

export function validateFleetPoints(points: number): LobbySettingsProblem | null {
  if (!Number.isInteger(points)) return 'fleet_points_out_of_range';
  if (points < FLEET_POINTS_MIN || points > FLEET_POINTS_MAX) {
    return 'fleet_points_out_of_range';
  }
  return null;
}

export function describeLobbySettingsProblem(problem: LobbySettingsProblem): string {
  switch (problem) {
    case 'name_too_short':
      return `Lobby name must be at least ${LOBBY_NAME_MIN_LENGTH} characters.`;
    case 'name_too_long':
      return `Lobby name must be at most ${LOBBY_NAME_MAX_LENGTH} characters.`;
    case 'name_invalid_characters':
      return "Lobby name may contain only letters, numbers, spaces, and the punctuation ' - _ . ! ?";
    case 'max_players_out_of_range':
      return `Player cap must be between ${MAX_PLAYERS_MIN} and ${MAX_PLAYERS_MAX}.`;
    case 'max_players_odd':
      return 'Player cap must be an even number, so both teams are the same size.';
    case 'fleet_points_out_of_range':
      return `Fleet point budget must be between ${FLEET_POINTS_MIN} and ${FLEET_POINTS_MAX}.`;
    case 'unknown_game_mode':
      return 'That is not a game mode.';
    case 'unknown_map_type':
      return 'That is not a map type.';
    case 'unknown_map_size':
      return 'That is not a map size.';
  }
}
