/**
 * LobbyHandler — the protocol layer: who gets told what, and what untrusted input does.
 *
 * The rules themselves are covered in lobby-service.test.ts. These tests are about message
 * shapes, broadcast targets, and the fact that a malformed field from the wire never reaches
 * the service.
 */
import type { LobbyClientMessage, LobbyState, ServerMessage } from '@seg/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { LobbyHandler, isLobbyMessage, type LobbyConnection } from '../src/lobby/handler.js';
import { LobbyService } from '../src/lobby/service.js';

let now = 1_000_000;

class FakeConnection implements LobbyConnection {
  readonly sent: ServerMessage[] = [];

  constructor(
    readonly accountId: string,
    readonly username: string,
  ) {}

  send(message: ServerMessage): void {
    this.sent.push(message);
  }

  /** The most recent message, which is what a command's outcome always is. */
  last(): ServerMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  states(): LobbyState[] {
    return this.sent.filter((m) => m.t === 'lobby.state').map((m) => m.lobby);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

interface Harness {
  handler: LobbyHandler;
  service: LobbyService;
  connect: (accountId: string, username: string) => FakeConnection;
  send: (conn: FakeConnection, msg: LobbyClientMessage) => void;
}

function harness(): Harness {
  let codeSeed = 0;
  const alphabet = 'BCDFGHJKMNPQRTVWXYZ2346789';
  const service = new LobbyService({
    clock: () => now,
    createCooldownMs: 0,
    generateCode: () => {
      codeSeed += 1;
      const a = alphabet[codeSeed % alphabet.length]!;
      const b = alphabet[(codeSeed * 7) % alphabet.length]!;
      return `${a}${b}${a}${b}${a}${b}`;
    },
  });
  const handler = new LobbyHandler(service);

  return {
    handler,
    service,
    connect(accountId, username) {
      const conn = new FakeConnection(accountId, username);
      handler.attach(conn);
      return conn;
    },
    send(conn, msg) {
      now += 1;
      handler.handle(conn, msg);
    },
  };
}

/** The lobby state a connection was last told about. */
function currentLobby(conn: FakeConnection): LobbyState {
  const states = conn.states();
  const last = states[states.length - 1];
  if (last === undefined) throw new Error(`${conn.accountId} was never sent a lobby.state`);
  return last;
}

function expectRejected(conn: FakeConnection, code: string) {
  const message = conn.last();
  if (message?.t !== 'lobby.rejected') {
    throw new Error(`expected lobby.rejected, got ${String(message?.t)}`);
  }
  expect(message.code).toBe(code);
  return message;
}

beforeEach(() => {
  now = 1_000_000;
});

describe('isLobbyMessage', () => {
  it('claims every lobby command and nothing else', () => {
    for (const t of [
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
    ]) {
      expect(isLobbyMessage({ t } as never)).toBe(true);
    }
    expect(isLobbyMessage({ t: 'ping', clientTime: 0 })).toBe(false);
    expect(isLobbyMessage({ t: 'lobby.state' } as never)).toBe(false);
  });
});

describe('lobby.create', () => {
  it('answers with the new lobby', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');

    h.send(host, { t: 'lobby.create', name: 'Deep Water' });

    const state = currentLobby(host);
    expect(state.settings.name).toBe('Deep Water');
    expect(state.hostAccountId).toBe('host');
  });

  it('rejects a bad name without inventing a lobby', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');

    h.send(host, { t: 'lobby.create', name: 'no' });

    expectRejected(host, 'validation_failed');
    expect(h.service.lobbyFor('host')).toBeNull();
  });

  it('treats a missing name as a validation failure rather than throwing', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');

    h.send(host, { t: 'lobby.create' } as LobbyClientMessage);

    expectRejected(host, 'validation_failed');
  });
});

describe('lobby.join', () => {
  it('accepts a code typed in lowercase with separators', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    const code = currentLobby(host).code;

    const guest = h.connect('guest', 'Guest');
    const messy = `${code.slice(0, 3)}-${code.slice(3)}`.toLowerCase();
    h.send(guest, { t: 'lobby.join', target: { by: 'code', code: messy } });

    expect(currentLobby(guest).members).toHaveLength(2);
  });

  it('joins a public lobby by id', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    const id = currentLobby(host).id;

    const guest = h.connect('guest', 'Guest');
    h.send(guest, { t: 'lobby.join', target: { by: 'id', lobbyId: id } });

    expect(currentLobby(guest).members).toHaveLength(2);
  });

  it('tells the existing members about the new arrival', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    const code = currentLobby(host).code;
    host.clear();

    const guest = h.connect('guest', 'Guest');
    h.send(guest, { t: 'lobby.join', target: { by: 'code', code } });

    expect(currentLobby(host).members).toHaveLength(2);
  });

  it('rejects a malformed code before it reaches the service', () => {
    const h = harness();
    const guest = h.connect('guest', 'Guest');

    h.send(guest, { t: 'lobby.join', target: { by: 'code', code: 'BCDFGA' } });

    // A vowel: caught by the shared join-code rules, not by a lobby lookup.
    expectRejected(guest, 'validation_failed');
  });

  it('rejects a target that is neither a code nor an id', () => {
    const h = harness();
    const guest = h.connect('guest', 'Guest');

    h.send(guest, {
      t: 'lobby.join',
      target: { by: 'telepathy' },
    } as unknown as LobbyClientMessage);
    expectRejected(guest, 'bad_request');

    h.send(guest, { t: 'lobby.join' } as LobbyClientMessage);
    expectRejected(guest, 'bad_request');

    h.send(guest, {
      t: 'lobby.join',
      target: { by: 'code', code: 42 },
    } as unknown as LobbyClientMessage);
    expectRejected(guest, 'bad_request');
  });
});

describe('lobby.setPosition', () => {
  it('moves the player and tells everyone', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    const code = currentLobby(host).code;
    const guest = h.connect('guest', 'Guest');
    h.send(guest, { t: 'lobby.join', target: { by: 'code', code } });
    host.clear();

    h.send(guest, { t: 'lobby.setPosition', position: 'spectator' });

    const seenByHost = currentLobby(host).members.find((m) => m.occupant.accountId === 'guest');
    expect(seenByHost?.position).toBe('spectator');
  });

  it('rejects a position that is not one of the three', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });

    h.send(host, { t: 'lobby.setPosition', position: 'team3' } as unknown as LobbyClientMessage);

    expectRejected(host, 'bad_request');
  });
});

describe('lobby.leave', () => {
  it('sends the leaver an exit and the rest the new state', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    const code = currentLobby(host).code;
    const guest = h.connect('guest', 'Guest');
    h.send(guest, { t: 'lobby.join', target: { by: 'code', code } });
    host.clear();
    guest.clear();

    h.send(guest, { t: 'lobby.leave' });

    expect(guest.last()).toEqual({ t: 'lobby.exit', reason: 'left' });
    expect(currentLobby(host).members).toHaveLength(1);
  });

  it('rejects a player who is not in a lobby', () => {
    const h = harness();
    const stranger = h.connect('stranger', 'Stranger');

    h.send(stranger, { t: 'lobby.leave' });

    expectRejected(stranger, 'not_in_lobby');
  });

  it('tells nobody when the last member leaves', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    host.clear();

    h.send(host, { t: 'lobby.leave' });

    expect(host.sent).toEqual([{ t: 'lobby.exit', reason: 'left' }]);
  });
});

describe('lobby.kick', () => {
  it('tells the kicked player why, and the rest the new state', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    const code = currentLobby(host).code;
    const guest = h.connect('guest', 'Guest');
    h.send(guest, { t: 'lobby.join', target: { by: 'code', code } });
    host.clear();
    guest.clear();

    h.send(host, { t: 'lobby.kick', accountId: 'guest' });

    expect(guest.last()).toEqual({ t: 'lobby.exit', reason: 'kicked' });
    expect(currentLobby(host).members).toHaveLength(1);
  });

  it('refuses a non-host, and tells only them', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    const code = currentLobby(host).code;
    const guest = h.connect('guest', 'Guest');
    h.send(guest, { t: 'lobby.join', target: { by: 'code', code } });
    const other = h.connect('other', 'Other');
    h.send(other, { t: 'lobby.join', target: { by: 'code', code } });
    host.clear();
    other.clear();
    guest.clear();

    h.send(guest, { t: 'lobby.kick', accountId: 'other' });

    expectRejected(guest, 'not_host');
    // A rejection is private to the caller: nobody else hears about a failed attempt.
    expect(host.sent).toHaveLength(0);
    expect(other.sent).toHaveLength(0);
  });

  it('rejects a missing or non-string player id', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });

    h.send(host, { t: 'lobby.kick' } as LobbyClientMessage);
    expectRejected(host, 'bad_request');

    h.send(host, { t: 'lobby.kick', accountId: 7 } as unknown as LobbyClientMessage);
    expectRejected(host, 'bad_request');
  });
});

describe('lobby.modify', () => {
  it('pushes the new settings to every member', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    const code = currentLobby(host).code;
    const guest = h.connect('guest', 'Guest');
    h.send(guest, { t: 'lobby.join', target: { by: 'code', code } });
    guest.clear();

    h.send(host, {
      t: 'lobby.modify',
      patch: { name: 'Cold Layer', maxPlayers: 4, mode: 'deathmatch', fleetPoints: 800 },
    });

    expect(currentLobby(guest).settings).toMatchObject({
      name: 'Cold Layer',
      maxPlayers: 4,
      mode: 'deathmatch',
      fleetPoints: 800,
    });
  });

  it('ignores fields it does not recognise rather than failing the request', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });

    // A newer client sending a setting this server has never heard of must not break the
    // settings it *does* understand — otherwise every protocol addition is breaking.
    h.send(host, {
      t: 'lobby.modify',
      patch: { fleetPoints: 900, terrainDensity: 'dense' },
    } as unknown as LobbyClientMessage);

    expect(currentLobby(host).settings.fleetPoints).toBe(900);
  });

  it('drops a wrong-typed field instead of passing it to the service', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    const before = currentLobby(host).settings;

    h.send(host, {
      t: 'lobby.modify',
      patch: { maxPlayers: '8', mode: 'chess' },
    } as unknown as LobbyClientMessage);

    // Both fields were dropped, so this is an empty patch and the settings are untouched.
    expect(currentLobby(host).settings).toEqual(before);
  });

  it('rejects a patch that is not an object', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });

    h.send(host, { t: 'lobby.modify', patch: 'everything' } as unknown as LobbyClientMessage);

    expectRejected(host, 'bad_request');
  });
});

describe('lobby.list', () => {
  it('answers with summaries and never leaks a join code', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });

    const browser = h.connect('browser', 'Browser');
    h.send(browser, { t: 'lobby.list', filter: {} });

    const result = browser.last();
    if (result?.t !== 'lobby.list.result') throw new Error('expected a list result');
    expect(result.lobbies).toHaveLength(1);
    expect(result.lobbies[0]).toEqual({
      id: currentLobby(host).id,
      name: 'Deep Water',
      playerCount: 1,
      maxPlayers: 6,
      mode: 'objective-capture',
      fleetPoints: 500,
    });
  });

  it('passes the filters through', () => {
    const h = harness();
    const a = h.connect('a', 'A');
    h.send(a, { t: 'lobby.create', name: 'Abyssal Trench' });
    const b = h.connect('b', 'B');
    h.send(b, { t: 'lobby.create', name: 'Cold Layer' });
    h.send(b, { t: 'lobby.modify', patch: { mode: 'deathmatch' } });

    const browser = h.connect('browser', 'Browser');
    h.send(browser, { t: 'lobby.list', filter: { mode: 'deathmatch' } });

    const result = browser.last();
    if (result?.t !== 'lobby.list.result') throw new Error('expected a list result');
    expect(result.lobbies.map((l) => l.name)).toEqual(['Cold Layer']);
  });

  it('treats a malformed filter as no filter rather than failing', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });

    const browser = h.connect('browser', 'Browser');
    h.send(browser, { t: 'lobby.list', filter: null } as unknown as LobbyClientMessage);

    const result = browser.last();
    if (result?.t !== 'lobby.list.result') throw new Error('expected a list result');
    expect(result.lobbies).toHaveLength(1);
  });

  it('is answerable without being in a lobby', () => {
    const h = harness();
    const browser = h.connect('browser', 'Browser');

    h.send(browser, { t: 'lobby.list', filter: {} });

    expect(browser.last()?.t).toBe('lobby.list.result');
  });
});

describe('attach', () => {
  it('sends nothing to a connection whose account is not in a lobby', () => {
    const h = harness();
    const conn = h.connect('browser', 'Browser');
    expect(conn.sent).toHaveLength(0);
  });

  it('tells a reconnecting account about the lobby it is already in', () => {
    const h = harness();
    const first = h.connect('host', 'Skipper');
    h.send(first, { t: 'lobby.create', name: 'Deep Water' });
    const lobbyId = currentLobby(first).id;

    // A second tab for the same account. Membership is on the account, not the socket.
    const second = h.connect('host', 'Skipper');

    expect(currentLobby(second).id).toBe(lobbyId);
  });

  it('does not remove the account from its lobby', () => {
    const h = harness();
    const first = h.connect('host', 'Skipper');
    h.send(first, { t: 'lobby.create', name: 'Deep Water' });

    h.connect('host', 'Skipper');

    expect(h.service.lobbyFor('host')?.members).toHaveLength(1);
  });
});

describe('disconnect', () => {
  it('removes the player from their lobby and tells the rest', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    const code = currentLobby(host).code;
    const guest = h.connect('guest', 'Guest');
    h.send(guest, { t: 'lobby.join', target: { by: 'code', code } });
    host.clear();

    h.handler.detach('guest');

    expect(currentLobby(host).members).toHaveLength(1);
    expect(h.service.lobbyFor('guest')).toBeNull();
  });

  it('migrates the host when the host is the one who dropped', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    const code = currentLobby(host).code;
    const guest = h.connect('guest', 'Guest');
    h.send(guest, { t: 'lobby.join', target: { by: 'code', code } });
    guest.clear();

    h.handler.detach('host');

    expect(currentLobby(guest).hostAccountId).toBe('guest');
  });

  it('stops sending to a detached connection', () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    const code = currentLobby(host).code;
    const guest = h.connect('guest', 'Guest');
    h.send(guest, { t: 'lobby.join', target: { by: 'code', code } });

    h.handler.detach('guest');
    guest.clear();

    // Something that would broadcast if the connection were still registered.
    h.send(host, { t: 'lobby.modify', patch: { fleetPoints: 900 } });

    expect(guest.sent).toHaveLength(0);
  });

  it('is harmless for a connection that was never in a lobby', () => {
    const h = harness();
    h.connect('browser', 'Browser');
    expect(() => h.handler.detach('browser')).not.toThrow();
  });
});

// ── fleet selection over the wire ───────────────────────────────────────────────

const FLEET = { id: 'f1', name: 'First Wolfpack', boatCount: 4, points: 460 };

/** A handler whose fleet lookup answers from a fixed table, keyed by account and id. */
function fleetHarness(
  owned: Record<string, Record<string, { name: string; boatCount: number; points: number }>>,
): Harness {
  const h = harness();
  const handler = new LobbyHandler(h.service, {
    fleets: async (accountId, fleetId) => {
      const row = owned[accountId]?.[fleetId];
      return row === undefined ? null : { id: fleetId, ...row };
    },
  });
  return {
    ...h,
    handler,
    connect(accountId, username) {
      const conn = new FakeConnection(accountId, username);
      handler.attach(conn);
      return conn;
    },
    send(conn, msg) {
      now += 1;
      handler.handle(conn, msg);
    },
  };
}

/** Lets the handler's one asynchronous step (the fleet lookup) settle. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The private half of the last lobby.state a connection received. */
function currentSelf(conn: FakeConnection) {
  const states = conn.sent.filter((m) => m.t === 'lobby.state');
  const last = states[states.length - 1];
  if (last?.t !== 'lobby.state') throw new Error(`${conn.accountId} was never sent a lobby.state`);
  return last.you;
}

describe('lobby.selectFleet', () => {
  it('resolves the fleet from the caller’s own account', async () => {
    const h = fleetHarness({ host: { f1: FLEET } });
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });

    h.send(host, { t: 'lobby.selectFleet', fleetId: 'f1' });
    await settled();

    expect(currentSelf(host).fleet?.name).toBe('First Wolfpack');
    expect(currentLobby(host).members[0]?.hasFleet).toBe(true);
  });

  it('shows other members that a fleet exists and never which one', async () => {
    const h = fleetHarness({ host: { f1: FLEET } });
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    const code = currentLobby(host).code;

    const guest = h.connect('guest', 'Bosun');
    h.send(guest, { t: 'lobby.join', target: { by: 'code', code } });

    guest.clear();
    h.send(host, { t: 'lobby.selectFleet', fleetId: 'f1' });
    await settled();

    // The guest is told the host is fielding something, and that is the whole of it. This
    // is asserted on the encoded message rather than a field, because the point is that the
    // name is not *anywhere* in what the guest received.
    expect(currentLobby(guest).members[0]?.hasFleet).toBe(true);
    expect(currentSelf(guest).fleet).toBeNull();
    expect(JSON.stringify(guest.sent)).not.toContain('First Wolfpack');
  });

  it('refuses a fleet belonging to somebody else, as if it did not exist', async () => {
    const h = fleetHarness({ other: { f1: FLEET } });
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });

    h.send(host, { t: 'lobby.selectFleet', fleetId: 'f1' });
    await settled();

    // Indistinguishable from a missing fleet — otherwise fleet ids become an oracle for
    // what other accounts own.
    expectRejected(host, 'not_found');
  });

  it('refuses a fleet over the lobby budget', async () => {
    const h = fleetHarness({ host: { f2: { name: 'Overweight', boatCount: 8, points: 900 } } });
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });

    h.send(host, { t: 'lobby.selectFleet', fleetId: 'f2' });
    await settled();

    expectRejected(host, 'fleet_over_budget');
  });

  it('clears the selection on a null id, without a lookup', () => {
    const h = fleetHarness({ host: { f1: FLEET } });
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });

    h.send(host, { t: 'lobby.selectFleet', fleetId: null });

    // Synchronous: there is nothing to look up, so the answer must not wait on a promise.
    expect(currentSelf(host).fleet).toBeNull();
  });

  it('rejects a malformed id rather than passing it to the lookup', () => {
    const h = fleetHarness({ host: { f1: FLEET } });
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });

    h.send(host, { t: 'lobby.selectFleet', fleetId: 42 as never });
    expectRejected(host, 'bad_request');
  });

  it('says so plainly when the server has no way to read fleets', async () => {
    const h = harness();
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });

    h.send(host, { t: 'lobby.selectFleet', fleetId: 'f1' });
    await settled();

    expectRejected(host, 'not_implemented');
  });

  it('hands back the state the reconnecting tab left behind, fleet included', async () => {
    const h = fleetHarness({ host: { f1: FLEET } });
    const first = h.connect('host', 'Skipper');
    h.send(first, { t: 'lobby.create', name: 'Deep Water' });
    h.send(first, { t: 'lobby.selectFleet', fleetId: 'f1' });
    await settled();

    // A second tab replaces the first. Membership lives on the account, so the private view
    // has to be recovered on attach too, or the new tab shows "No fleet" for a seated player.
    const second = h.connect('host', 'Skipper');
    expect(currentSelf(second).fleet?.name).toBe('First Wolfpack');
  });
});

describe('lobby.setReady and lobby.start', () => {
  async function readyLobby(): Promise<{
    h: Harness;
    host: FakeConnection;
    guest: FakeConnection;
  }> {
    const h = fleetHarness({ host: { f1: FLEET }, guest: { f1: FLEET } });
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    const code = currentLobby(host).code;

    const guest = h.connect('guest', 'Bosun');
    h.send(guest, { t: 'lobby.join', target: { by: 'code', code } });

    for (const conn of [host, guest]) {
      h.send(conn, { t: 'lobby.selectFleet', fleetId: 'f1' });
      await settled();
      h.send(conn, { t: 'lobby.setReady', ready: true });
    }
    return { h, host, guest };
  }

  it('tells everyone in the lobby who is ready', async () => {
    const { host, guest } = await readyLobby();
    expect(currentLobby(guest).members.every((m) => m.ready)).toBe(true);
    expect(currentLobby(host).members.every((m) => m.ready)).toBe(true);
  });

  it('rejects a ready flag that is not a boolean', () => {
    const h = fleetHarness({});
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });

    h.send(host, { t: 'lobby.setReady', ready: 'yes' as never });
    expectRejected(host, 'bad_request');
  });

  it('refuses a start from someone who is not the host', async () => {
    const { h, guest } = await readyLobby();
    h.send(guest, { t: 'lobby.start' });
    expectRejected(guest, 'not_host');
  });

  it('refuses a start while someone is not ready', async () => {
    const { h, host, guest } = await readyLobby();
    h.send(guest, { t: 'lobby.setReady', ready: false });

    h.send(host, { t: 'lobby.start' });
    expectRejected(host, 'not_all_ready');
  });

  it('gets past authorization and says the match runtime is not built yet', async () => {
    const { h, host } = await readyLobby();
    h.send(host, { t: 'lobby.start' });

    // Honest rather than silent: the request was legal, and there is nothing behind it. When
    // the match runtime lands, this is the only assertion in the file that changes.
    expectRejected(host, 'not_implemented');
  });
});

describe('fleetChanged', () => {
  it('drops a selection that was edited past the budget, and tells the lobby', async () => {
    const owned: Record<
      string,
      Record<string, { name: string; boatCount: number; points: number }>
    > = { host: { f1: { name: 'First Wolfpack', boatCount: 4, points: 460 } } };
    const h = fleetHarness(owned);
    const host = h.connect('host', 'Skipper');
    h.send(host, { t: 'lobby.create', name: 'Deep Water' });
    h.send(host, { t: 'lobby.selectFleet', fleetId: 'f1' });
    await settled();
    h.send(host, { t: 'lobby.setReady', ready: true });

    // The player goes back to the editor and adds boats. Without this path the budget is
    // advisory: select cheap, then edit up.
    owned['host']!['f1'] = { name: 'First Wolfpack', boatCount: 9, points: 900 };
    h.handler.fleetChanged('host', 'f1');
    await settled();

    expect(currentLobby(host).members[0]?.hasFleet).toBe(false);
    expect(currentLobby(host).members[0]?.ready).toBe(false);
  });

  it('costs nothing for an account in no lobby', () => {
    const h = fleetHarness({ host: { f1: FLEET } });
    const host = h.connect('host', 'Skipper');
    host.clear();

    h.handler.fleetChanged('host', 'f1');

    expect(host.sent).toHaveLength(0);
  });
});
