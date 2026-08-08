/**
 * LobbyService — the rules, without a network.
 *
 * The service is pure in-memory logic with an injected clock, so these run instantly and
 * cover the cases that are awkward to reach through a socket: capacity edges, host
 * migration, and the privacy property on unlisted lobbies.
 */
import { MAX_PLAYERS_DEFAULT, SPECTATOR_CAP } from '@seg/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { LobbyService, type LobbyResult } from '../src/lobby/service.js';

let now = 1_000_000;
const clock = () => now;

/** Deterministic codes, so tests can assert on them and force a collision. */
function sequentialCodes(): () => string {
  let n = 0;
  const alphabet = 'BCDFGHJKMNPQRTVWXYZ2346789';
  return () => {
    n += 1;
    // Six characters from the real alphabet, distinct per call.
    const a = alphabet[n % alphabet.length]!;
    const b = alphabet[(n * 7) % alphabet.length]!;
    return `${a}${b}${a}${b}${a}${b}`;
  };
}

function service(): LobbyService {
  return new LobbyService({ clock, generateCode: sequentialCodes(), createCooldownMs: 0 });
}

function unwrap<T>(result: LobbyResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
  return result.value;
}

function expectFail<T>(result: LobbyResult<T>): { code: string; message: string } {
  if (result.ok) throw new Error('expected failure, got success');
  return { code: result.code, message: result.message };
}

/** Fill a lobby's player slots with joiners, returning their account ids. */
function fillPlayers(svc: LobbyService, code: string, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `filler-${i}-${code}`;
    now += 1;
    unwrap(svc.joinByCode(id, `Filler${i}`, code));
    ids.push(id);
  }
  return ids;
}

beforeEach(() => {
  now = 1_000_000;
});

describe('create', () => {
  it('seats the host on a team rather than in the spectators', () => {
    const svc = service();
    const lobby = unwrap(svc.create('host', 'Skipper', 'Deep Water'));

    expect(lobby.hostAccountId).toBe('host');
    expect(lobby.members).toHaveLength(1);
    expect(lobby.members[0]?.position).toBe('team1');
  });

  it('applies the documented defaults', () => {
    const svc = service();
    const lobby = unwrap(svc.create('host', 'Skipper', 'Deep Water'));

    expect(lobby.settings.maxPlayers).toBe(MAX_PLAYERS_DEFAULT);
    expect(lobby.settings.mode).toBe('objective-capture');
    expect(lobby.settings.fleetPoints).toBe(500);
    expect(lobby.settings.visibility).toBe('public');
  });

  it('normalizes the name before storing it', () => {
    const svc = service();
    const lobby = unwrap(svc.create('host', 'Skipper', '  Deep    Water  '));
    expect(lobby.settings.name).toBe('Deep Water');
  });

  it('rejects names that fail the shared rules', () => {
    const svc = service();
    expect(expectFail(svc.create('a', 'A', 'no')).code).toBe('validation_failed');
    expect(expectFail(svc.create('b', 'B', 'x'.repeat(33))).code).toBe('validation_failed');
    expect(expectFail(svc.create('c', 'C', 'Deep <script>')).code).toBe('validation_failed');
  });

  it('refuses a second lobby while the account is still in one', () => {
    const svc = service();
    unwrap(svc.create('host', 'Skipper', 'First Lobby'));
    expect(expectFail(svc.create('host', 'Skipper', 'Second Lobby')).code).toBe('already_in_lobby');
  });

  it('rate limits creation per account', () => {
    const svc = new LobbyService({
      clock,
      generateCode: sequentialCodes(),
      createCooldownMs: 10_000,
    });
    const first = unwrap(svc.create('host', 'Skipper', 'First Lobby'));
    unwrap(svc.leave('host'));

    expect(expectFail(svc.create('host', 'Skipper', 'Second Lobby')).code).toBe('rate_limited');

    now += 10_000;
    const second = unwrap(svc.create('host', 'Skipper', 'Second Lobby'));
    expect(second.id).not.toBe(first.id);
  });

  it('gives every lobby a distinct join code', () => {
    const svc = service();
    const a = unwrap(svc.create('a', 'A', 'Lobby One'));
    const b = unwrap(svc.create('b', 'B', 'Lobby Two'));
    expect(a.code).not.toBe(b.code);
  });

  it('throws rather than spinning if codes stop being unique', () => {
    const svc = new LobbyService({ clock, generateCode: () => 'BCDFGH', createCooldownMs: 0 });
    unwrap(svc.create('a', 'A', 'Lobby One'));
    expect(() => svc.create('b', 'B', 'Lobby Two')).toThrow(/unique join code/);
  });
});

describe('join', () => {
  it('admits a player by code and balances them onto the emptier team', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));

    now += 1;
    const joined = unwrap(svc.joinByCode('guest', 'Guest', created.code));

    expect(joined.members).toHaveLength(2);
    expect(joined.members[1]?.position).toBe('team2');
  });

  it('accepts a lowercase, hyphenated code only after normalization', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));

    // The service takes an already-normalized code; the handler is what normalizes.
    expect(expectFail(svc.joinByCode('guest', 'Guest', created.code.toLowerCase())).code).toBe(
      'not_found',
    );
  });

  it('admits a player to a public lobby by id', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));

    now += 1;
    const joined = unwrap(svc.joinById('guest', 'Guest', created.id));
    expect(joined.members).toHaveLength(2);
  });

  it('refuses to admit anyone to an unlisted lobby by id, even with a valid id', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    unwrap(svc.modify('host', { visibility: 'unlisted' }));

    const failure = expectFail(svc.joinById('guest', 'Guest', created.id));

    // Indistinguishable from an unknown id on purpose: a different error would let anyone
    // holding an id confirm a private lobby exists without having been given the code.
    expect(failure.code).toBe('not_found');
    expect(failure.message).not.toMatch(/unlisted|private/i);

    // The code still works, which is the whole point of being unlisted rather than closed.
    now += 1;
    expect(unwrap(svc.joinByCode('guest', 'Guest', created.code)).members).toHaveLength(2);
  });

  it('refuses a player who is already in another lobby', () => {
    const svc = service();
    unwrap(svc.create('host', 'Skipper', 'First Lobby'));
    const other = unwrap(svc.create('other', 'Other', 'Second Lobby'));

    expect(expectFail(svc.joinByCode('host', 'Skipper', other.code)).code).toBe('already_in_lobby');
  });

  it('falls back to spectating when both teams are full', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    fillPlayers(svc, created.code, MAX_PLAYERS_DEFAULT - 1);

    now += 1;
    const late = unwrap(svc.joinByCode('late', 'Late', created.code));
    const member = late.members.find((m) => m.occupant.accountId === 'late');
    expect(member?.position).toBe('spectator');
  });

  it('refuses only once the spectator slots are gone too', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    fillPlayers(svc, created.code, MAX_PLAYERS_DEFAULT - 1 + SPECTATOR_CAP);

    now += 1;
    expect(expectFail(svc.joinByCode('overflow', 'Overflow', created.code)).code).toBe(
      'lobby_full',
    );
  });

  it('reports an unknown code as not found', () => {
    const svc = service();
    expect(expectFail(svc.joinByCode('guest', 'Guest', 'BCDFGH')).code).toBe('not_found');
  });
});

describe('setPosition', () => {
  it('moves a player between teams and to the spectators', () => {
    const svc = service();
    unwrap(svc.create('host', 'Skipper', 'Deep Water'));

    expect(unwrap(svc.setPosition('host', 'team2')).members[0]?.position).toBe('team2');
    expect(unwrap(svc.setPosition('host', 'spectator')).members[0]?.position).toBe('spectator');
    expect(unwrap(svc.setPosition('host', 'team1')).members[0]?.position).toBe('team1');
  });

  it('is a no-op when already in that position', () => {
    const svc = service();
    unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    expect(unwrap(svc.setPosition('host', 'team1')).members[0]?.position).toBe('team1');
  });

  it('refuses a move onto a full team', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    unwrap(svc.modify('host', { maxPlayers: 2 }));

    now += 1;
    unwrap(svc.joinByCode('guest', 'Guest', created.code)); // lands on team2

    expect(expectFail(svc.setPosition('guest', 'team1')).code).toBe('team_full');
  });

  it('does not count the mover against their own destination', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    unwrap(svc.modify('host', { maxPlayers: 2 }));
    now += 1;
    unwrap(svc.joinByCode('guest', 'Guest', created.code));

    // team2 holds exactly one player — the mover. Moving there again must not read the
    // team as full because of themselves.
    expect(unwrap(svc.setPosition('guest', 'team2')).members).toHaveLength(2);
  });

  it('refuses when the spectator slots are full', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    const fillers = fillPlayers(svc, created.code, MAX_PLAYERS_DEFAULT - 1 + SPECTATOR_CAP);
    // The last SPECTATOR_CAP fillers are spectators; everyone else is on a team.
    expect(fillers.length).toBeGreaterThan(SPECTATOR_CAP);

    expect(expectFail(svc.setPosition('host', 'spectator')).code).toBe('spectators_full');
  });

  it('rejects a player who is not in a lobby', () => {
    const svc = service();
    expect(expectFail(svc.setPosition('nobody', 'team1')).code).toBe('not_in_lobby');
  });
});

describe('leave and host migration', () => {
  it('removes the player and frees them to join elsewhere', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    now += 1;
    unwrap(svc.joinByCode('guest', 'Guest', created.code));

    const mutation = unwrap(svc.leave('guest'));
    expect(mutation.state?.members).toHaveLength(1);
    expect(mutation.removed).toEqual(['guest']);
    expect(svc.lobbyFor('guest')).toBeNull();
  });

  it('destroys the lobby when the last member leaves', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));

    const mutation = unwrap(svc.leave('host'));
    expect(mutation.state).toBeNull();
    expect(svc.list({})).toHaveLength(0);
    // The code is released with the lobby.
    expect(expectFail(svc.joinByCode('guest', 'Guest', created.code)).code).toBe('not_found');
  });

  it('migrates the host to the longest-connected remaining player', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    now += 10;
    unwrap(svc.joinByCode('early', 'Early', created.code));
    now += 10;
    unwrap(svc.joinByCode('late', 'Late', created.code));

    const mutation = unwrap(svc.leave('host'));
    expect(mutation.state?.hostAccountId).toBe('early');
  });

  it('prefers a player over a longer-seated spectator when migrating', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    now += 10;
    unwrap(svc.joinByCode('watcher', 'Watcher', created.code));
    unwrap(svc.setPosition('watcher', 'spectator'));
    now += 10;
    unwrap(svc.joinByCode('player', 'Player', created.code));

    // A lobby handed to a spectator has nobody able to start it.
    expect(unwrap(svc.leave('host')).state?.hostAccountId).toBe('player');
  });
});

describe('kick', () => {
  it('lets the host remove a player', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    now += 1;
    unwrap(svc.joinByCode('guest', 'Guest', created.code));

    const mutation = unwrap(svc.kick('host', 'guest'));
    expect(mutation.state?.members).toHaveLength(1);
    expect(mutation.removed).toEqual(['guest']);
    expect(svc.lobbyFor('guest')).toBeNull();
  });

  it('refuses a non-host', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    now += 1;
    unwrap(svc.joinByCode('guest', 'Guest', created.code));
    now += 1;
    unwrap(svc.joinByCode('other', 'Other', created.code));

    expect(expectFail(svc.kick('guest', 'other')).code).toBe('not_host');
  });

  it('refuses the host kicking themselves', () => {
    const svc = service();
    unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    expect(expectFail(svc.kick('host', 'host')).code).toBe('cannot_kick_host');
  });

  it('refuses an account that is not in the lobby', () => {
    const svc = service();
    unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    expect(expectFail(svc.kick('host', 'stranger')).code).toBe('not_found');
  });
});

describe('modify', () => {
  it('changes every setting the host controls', () => {
    const svc = service();
    unwrap(svc.create('host', 'Skipper', 'Deep Water'));

    const updated = unwrap(
      svc.modify('host', {
        name: 'Cold Layer',
        maxPlayers: 8,
        mode: 'deathmatch',
        fleetPoints: 750,
        visibility: 'unlisted',
      }),
    );

    expect(updated.settings).toEqual({
      name: 'Cold Layer',
      maxPlayers: 8,
      mode: 'deathmatch',
      fleetPoints: 750,
      visibility: 'unlisted',
    });
  });

  it('leaves absent fields alone', () => {
    const svc = service();
    unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    const updated = unwrap(svc.modify('host', { fleetPoints: 900 }));

    expect(updated.settings.name).toBe('Deep Water');
    expect(updated.settings.maxPlayers).toBe(MAX_PLAYERS_DEFAULT);
    expect(updated.settings.mode).toBe('objective-capture');
  });

  it('refuses a non-host', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    now += 1;
    unwrap(svc.joinByCode('guest', 'Guest', created.code));

    expect(expectFail(svc.modify('guest', { fleetPoints: 900 })).code).toBe('not_host');
  });

  it('enforces the shared bounds', () => {
    const svc = service();
    unwrap(svc.create('host', 'Skipper', 'Deep Water'));

    expect(expectFail(svc.modify('host', { maxPlayers: 18 })).code).toBe('validation_failed');
    expect(expectFail(svc.modify('host', { maxPlayers: 5 })).message).toMatch(/even number/i);
    expect(expectFail(svc.modify('host', { fleetPoints: 100 })).code).toBe('validation_failed');
    expect(expectFail(svc.modify('host', { fleetPoints: 1600 })).code).toBe('validation_failed');
    expect(expectFail(svc.modify('host', { name: 'no' })).code).toBe('validation_failed');
  });

  it('refuses a cap below the players already seated, rather than evicting anyone', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    fillPlayers(svc, created.code, 3); // 4 players seated

    const failure = expectFail(svc.modify('host', { maxPlayers: 2 }));
    expect(failure.code).toBe('below_current_occupancy');
    // Nobody was removed by the failed attempt.
    expect(svc.lobbyFor('host')?.members).toHaveLength(4);
  });

  it('refuses a cap that would overfill one team even when the total fits', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    now += 1;
    unwrap(svc.joinByCode('a', 'A', created.code));
    now += 1;
    unwrap(svc.joinByCode('b', 'B', created.code));
    // Put three of the four on team1: total 3 fits a cap of 4, but 3 > 4/2.
    unwrap(svc.setPosition('a', 'team1'));
    unwrap(svc.setPosition('b', 'team1'));

    expect(expectFail(svc.modify('host', { maxPlayers: 4 })).code).toBe('below_current_occupancy');
  });
});

describe('list', () => {
  function seed(svc: LobbyService) {
    const alpha = unwrap(svc.create('h1', 'H1', 'Abyssal Trench'));
    now += 1;
    const bravo = unwrap(svc.create('h2', 'H2', 'Cold Layer'));
    unwrap(svc.modify('h2', { mode: 'deathmatch' }));
    now += 1;
    const charlie = unwrap(svc.create('h3', 'H3', 'Silent Running'));
    unwrap(svc.modify('h3', { visibility: 'unlisted' }));
    return { alpha, bravo, charlie };
  }

  it('returns exactly the summary fields, and never the join code', () => {
    const svc = service();
    unwrap(svc.create('h1', 'H1', 'Abyssal Trench'));

    const [row] = svc.list({});
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'fleetPoints',
      'id',
      'maxPlayers',
      'mode',
      'name',
      'playerCount',
    ]);
    expect(JSON.stringify(row)).not.toContain('code');
  });

  it('omits unlisted lobbies entirely', () => {
    const svc = service();
    const { charlie } = seed(svc);

    const names = svc.list({}).map((l) => l.name);
    expect(names).not.toContain('Silent Running');
    expect(svc.list({}).some((l) => l.id === charlie.id)).toBe(false);
  });

  it('filters by name, case-insensitively, on a substring', () => {
    const svc = service();
    seed(svc);
    expect(svc.list({ name: 'cold' }).map((l) => l.name)).toEqual(['Cold Layer']);
    expect(svc.list({ name: 'LAYER' }).map((l) => l.name)).toEqual(['Cold Layer']);
    expect(svc.list({ name: 'nothing here' })).toHaveLength(0);
  });

  it('treats an empty name filter as no filter', () => {
    const svc = service();
    seed(svc);
    expect(svc.list({ name: '   ' })).toHaveLength(2);
  });

  it('filters by game mode', () => {
    const svc = service();
    seed(svc);
    expect(svc.list({ mode: 'deathmatch' }).map((l) => l.name)).toEqual(['Cold Layer']);
    expect(svc.list({ mode: 'objective-capture' }).map((l) => l.name)).toEqual(['Abyssal Trench']);
  });

  it('filters out full lobbies when open slots are requested', () => {
    const svc = service();
    const { alpha } = seed(svc);
    fillPlayers(svc, alpha.code, MAX_PLAYERS_DEFAULT - 1);

    expect(svc.list({}).some((l) => l.id === alpha.id)).toBe(true);
    expect(svc.list({ hasOpenSlots: true }).some((l) => l.id === alpha.id)).toBe(false);
  });

  it('counts players but not spectators against the cap', () => {
    const svc = service();
    const created = unwrap(svc.create('host', 'Skipper', 'Deep Water'));
    now += 1;
    unwrap(svc.joinByCode('watcher', 'Watcher', created.code));
    unwrap(svc.setPosition('watcher', 'spectator'));

    expect(svc.list({})[0]?.playerCount).toBe(1);
  });

  it('sorts fullest first, so a nearly-full lobby is easiest to find', () => {
    const svc = service();
    const { alpha, bravo } = seed(svc);
    fillPlayers(svc, bravo.code, 2);

    const ids = svc.list({}).map((l) => l.id);
    expect(ids).toEqual([bravo.id, alpha.id]);
  });

  it('combines filters', () => {
    const svc = service();
    seed(svc);
    expect(svc.list({ mode: 'deathmatch', name: 'abyssal' })).toHaveLength(0);
    expect(svc.list({ mode: 'deathmatch', hasOpenSlots: true })).toHaveLength(1);
  });
});

describe('snapshots', () => {
  it('does not let a caller mutate the registry through a returned state', () => {
    const svc = service();
    const lobby = unwrap(svc.create('host', 'Skipper', 'Deep Water'));

    (lobby.members as { position: string }[])[0]!.position = 'spectator';

    expect(svc.lobbyFor('host')?.members[0]?.position).toBe('team1');
  });
});
