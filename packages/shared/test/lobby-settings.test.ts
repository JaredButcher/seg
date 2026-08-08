import {
  FLEET_POINTS_MAX,
  FLEET_POINTS_MIN,
  GAME_MODES,
  LOBBY_POSITIONS,
  MAX_PLAYERS_DEFAULT,
  MAX_PLAYERS_MAX,
  MAX_PLAYERS_MIN,
  describeGameMode,
  describeLobbySettingsProblem,
  isGameMode,
  isLobbyPosition,
  normalizeLobbyName,
  playerCount,
  positionCount,
  spectatorCount,
  teamCapacity,
  toSummary,
  validateFleetPoints,
  validateLobbyName,
  validateMaxPlayers,
  type LobbyMember,
  type LobbyState,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

function member(accountId: string, position: LobbyMember['position']): LobbyMember {
  return { occupant: { kind: 'human', accountId }, username: accountId, position, joinedAt: 0 };
}

describe('game modes', () => {
  it('recognises exactly the declared modes', () => {
    for (const mode of GAME_MODES) expect(isGameMode(mode)).toBe(true);
    expect(isGameMode('chess')).toBe(false);
    expect(isGameMode(undefined)).toBe(false);
    expect(isGameMode(7)).toBe(false);
  });

  it('has a label for every mode', () => {
    for (const mode of GAME_MODES) expect(describeGameMode(mode).length).toBeGreaterThan(0);
  });
});

describe('positions', () => {
  it('recognises exactly the three positions', () => {
    for (const position of LOBBY_POSITIONS) expect(isLobbyPosition(position)).toBe(true);
    expect(isLobbyPosition('team3')).toBe(false);
    expect(isLobbyPosition(null)).toBe(false);
  });
});

describe('normalizeLobbyName', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeLobbyName('  Deep    Water  ')).toBe('Deep Water');
    expect(normalizeLobbyName('Deep\t\tWater')).toBe('Deep Water');
  });

  it('is idempotent', () => {
    const once = normalizeLobbyName('  Deep    Water  ');
    expect(normalizeLobbyName(once)).toBe(once);
  });
});

describe('validateLobbyName', () => {
  it('accepts an ordinary name and the permitted punctuation', () => {
    expect(validateLobbyName('Deep Water')).toBeNull();
    expect(validateLobbyName("Ivan's Run - 3v3!")).toBeNull();
    expect(validateLobbyName('no_vowels.ok?')).toBeNull();
  });

  it('enforces the length bounds', () => {
    expect(validateLobbyName('ab')).toBe('name_too_short');
    expect(validateLobbyName('x'.repeat(33))).toBe('name_too_long');
    expect(validateLobbyName('x'.repeat(32))).toBeNull();
  });

  it('rejects the characters that make a server browser row dangerous', () => {
    // No moderation tooling ships at 1.0 (planning/01 §8), so the surface stays small.
    expect(validateLobbyName('Deep <b>Water</b>')).toBe('name_invalid_characters');
    expect(validateLobbyName('Deep‮Water')).toBe('name_invalid_characters'); // RTL override
    expect(validateLobbyName('Deep​Water')).toBe('name_invalid_characters'); // zero-width
    expect(validateLobbyName('Ｄｅｅｐ Ｗａｔｅｒ')).toBe('name_invalid_characters'); // homoglyphs
  });
});

describe('validateMaxPlayers', () => {
  it('accepts even values in range', () => {
    for (let n = MAX_PLAYERS_MIN; n <= MAX_PLAYERS_MAX; n += 2) {
      expect(validateMaxPlayers(n)).toBeNull();
    }
  });

  it('rejects odd values, so both teams stay the same size', () => {
    expect(validateMaxPlayers(5)).toBe('max_players_odd');
    expect(validateMaxPlayers(15)).toBe('max_players_odd');
  });

  it('rejects out-of-range and non-integers', () => {
    expect(validateMaxPlayers(0)).toBe('max_players_out_of_range');
    expect(validateMaxPlayers(18)).toBe('max_players_out_of_range');
    expect(validateMaxPlayers(6.5)).toBe('max_players_out_of_range');
    expect(validateMaxPlayers(Number.NaN)).toBe('max_players_out_of_range');
  });

  it('defaults to 3v3', () => {
    expect(MAX_PLAYERS_DEFAULT).toBe(6);
    expect(teamCapacity(MAX_PLAYERS_DEFAULT)).toBe(3);
  });
});

describe('validateFleetPoints', () => {
  it('accepts the documented range', () => {
    expect(validateFleetPoints(FLEET_POINTS_MIN)).toBeNull();
    expect(validateFleetPoints(500)).toBeNull();
    expect(validateFleetPoints(FLEET_POINTS_MAX)).toBeNull();
  });

  it('rejects outside it, and non-integers', () => {
    expect(validateFleetPoints(FLEET_POINTS_MIN - 1)).toBe('fleet_points_out_of_range');
    expect(validateFleetPoints(FLEET_POINTS_MAX + 1)).toBe('fleet_points_out_of_range');
    expect(validateFleetPoints(500.5)).toBe('fleet_points_out_of_range');
  });
});

describe('describeLobbySettingsProblem', () => {
  it('has text for every problem, quoting the real bounds', () => {
    expect(describeLobbySettingsProblem('name_too_short')).toContain('3');
    expect(describeLobbySettingsProblem('name_too_long')).toContain('32');
    expect(describeLobbySettingsProblem('max_players_out_of_range')).toContain('16');
    expect(describeLobbySettingsProblem('fleet_points_out_of_range')).toContain('1500');
    expect(describeLobbySettingsProblem('max_players_odd')).toMatch(/even/i);
    expect(describeLobbySettingsProblem('name_invalid_characters').length).toBeGreaterThan(0);
    expect(describeLobbySettingsProblem('unknown_game_mode').length).toBeGreaterThan(0);
  });
});

describe('counting', () => {
  const members = [
    member('a', 'team1'),
    member('b', 'team1'),
    member('c', 'team2'),
    member('d', 'spectator'),
    member('e', 'spectator'),
  ];

  it('counts players without spectators', () => {
    expect(playerCount(members)).toBe(3);
  });

  it('counts spectators separately', () => {
    expect(spectatorCount(members)).toBe(2);
  });

  it('counts a single position', () => {
    expect(positionCount(members, 'team1')).toBe(2);
    expect(positionCount(members, 'team2')).toBe(1);
  });
});

describe('toSummary', () => {
  const state: LobbyState = {
    id: 'lobby-1',
    code: 'BCDFGH',
    hostAccountId: 'host',
    settings: {
      name: 'Deep Water',
      maxPlayers: 6,
      mode: 'deathmatch',
      fleetPoints: 750,
      visibility: 'public',
    },
    members: [member('host', 'team1'), member('watcher', 'spectator')],
    createdAt: 0,
  };

  it('carries exactly the browser fields', () => {
    expect(toSummary(state)).toEqual({
      id: 'lobby-1',
      name: 'Deep Water',
      playerCount: 1,
      maxPlayers: 6,
      mode: 'deathmatch',
      fleetPoints: 750,
    });
  });

  it('never carries the join code, the host, or the member list', () => {
    const summary = JSON.stringify(toSummary(state));
    expect(summary).not.toContain('BCDFGH');
    expect(summary).not.toContain('host');
    expect(summary).not.toContain('watcher');
  });
});
