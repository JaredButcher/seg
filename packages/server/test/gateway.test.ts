/**
 * The WebSocket gateway, against the real server.
 *
 * These run over an actual socket to an actual `createApp`, because the thing worth testing
 * is the seam the unit tests cannot reach: that the upgrade is authenticated from the session
 * cookie, and that lobby commands survive the whole encode/transport/decode round trip.
 */
import {
  AUTH_ROUTES,
  FLEET_ROUTES,
  JsonCodec,
  MATCH_DURATION_SECONDS,
  SESSION_COOKIE,
  TerrainRuler,
  type AuthenticatedResponse,
  type BoatTemplate,
  type ClientMessage,
  type FleetResponse,
  type MatchSetup,
  type Message,
} from '@seg/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { api, cookieValue, startTestApp, type TestApp } from './helpers.js';

const GOOD_PASSWORD = 'correct horse battery staple';
const codec = new JsonCodec();

let t: TestApp;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  t = await startTestApp();
});

afterEach(async () => {
  for (const socket of openSockets) socket.terminate();
  openSockets.length = 0;
  await t.close();
});

/** Creates an account and returns the cookie its session lives in. */
async function account(username: string): Promise<string> {
  const res = await api<AuthenticatedResponse>(t.baseUrl, AUTH_ROUTES.signup, {
    method: 'POST',
    body: { username, password: GOOD_PASSWORD, rememberMe: true },
  });
  return cookieValue(res.setCookie);
}

/** A connected client that records everything the server sends it. */
interface Client {
  socket: WebSocket;
  received: Message[];
  send(msg: ClientMessage): void;
  /** Resolves with the first message matching `t`, or rejects on timeout. */
  next(type: string, timeoutMs?: number): Promise<Message>;
}

function connect(cookie: string | null): Promise<Client> {
  const url = `${t.baseUrl.replace('http://', 'ws://')}/ws`;
  const socket = new WebSocket(url, cookie === null ? {} : { headers: { cookie } });
  openSockets.push(socket);

  const received: Message[] = [];
  const waiters: { type: string; resolve: (m: Message) => void }[] = [];

  socket.on('message', (data) => {
    const bytes =
      data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
    const msg = codec.decode(bytes);
    received.push(msg);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i]!;
      if (waiter.type === msg.t) {
        waiters.splice(i, 1);
        waiter.resolve(msg);
      }
    }
  });

  return new Promise((resolve, reject) => {
    socket.on('open', () =>
      resolve({
        socket,
        received,
        send: (msg) => socket.send(codec.encode(msg)),
        next(type, timeoutMs = 2000) {
          const already = received.find((m) => m.t === type);
          if (already !== undefined) return Promise.resolve(already);
          return new Promise((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error(`timed out waiting for ${type}`)),
              timeoutMs,
            );
            waiters.push({
              type,
              resolve: (m) => {
                clearTimeout(timer);
                res(m);
              },
            });
          });
        },
      }),
    );
    socket.on('error', reject);
  });
}

describe('the upgrade', () => {
  it('accepts a request carrying a valid session cookie', async () => {
    const cookie = await account('Skipper');
    const client = await connect(cookie);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('refuses a request with no cookie', async () => {
    // The socket must never open — an unauthenticated peer holding a connection is a free
    // resource-exhaustion lever, which is why auth is at the upgrade and not in a message.
    await expect(connect(null)).rejects.toThrow(/401/);
  });

  it('refuses a cookie that is not a live session', async () => {
    await expect(connect(`${SESSION_COOKIE}=not-a-real-token`)).rejects.toThrow(/401/);
  });

  it('refuses a session that has been logged out', async () => {
    const cookie = await account('Skipper');
    await api(t.baseUrl, AUTH_ROUTES.logout, { method: 'POST', cookie });

    await expect(connect(cookie)).rejects.toThrow(/401/);
  });

  it('refuses an upgrade on any other path, rather than leaving the socket hanging', async () => {
    const cookie = await account('Skipper');
    const url = `${t.baseUrl.replace('http://', 'ws://')}/not-the-gateway`;
    const socket = new WebSocket(url, { headers: { cookie } });
    openSockets.push(socket);

    // Returning without answering would hold the socket open indefinitely, because
    // registering an `upgrade` listener tells Node that upgrades are handled.
    await expect(
      new Promise((resolve, reject) => {
        socket.on('open', resolve);
        socket.on('error', reject);
      }),
    ).rejects.toThrow(/404/);
  });

  it('replaces the earlier socket for an account rather than running both', async () => {
    const cookie = await account('Skipper');
    const first = await connect(cookie);
    const closed = new Promise<void>((resolve) => first.socket.on('close', () => resolve()));

    const second = await connect(cookie);

    // Two live sockets for one account would fight over the lobby registry, which is keyed
    // by account — a stale tab could act on a lobby the player has already left.
    await closed;
    expect(first.socket.readyState).toBe(WebSocket.CLOSED);
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('tells the replaced socket why, before closing it', async () => {
    const cookie = await account('Skipper');
    const first = await connect(cookie);

    await connect(cookie);

    // Without this the losing tab sees a bare close, which is indistinguishable from the
    // network dropping — and one of the two is the player's own doing.
    await first.next('session.replaced');
  });
});

/** The account id the server assigned, read back off a lobby.state the client received. */
function recoveredAccountId(client: Client): string {
  const state = client.received.filter((m) => m.t === 'lobby.state').at(-1);
  if (state?.t !== 'lobby.state') throw new Error('no lobby.state received');
  const id = state.lobby.members[0]?.occupant.accountId;
  if (id === undefined) throw new Error('lobby has no members');
  return id;
}

describe('lobby commands over the socket', () => {
  it('creates a lobby and answers with its state', async () => {
    const cookie = await account('Skipper');
    const client = await connect(cookie);

    client.send({ t: 'lobby.create', name: 'Abyssal Trench' });
    const msg = await client.next('lobby.state');

    if (msg.t !== 'lobby.state') throw new Error('wrong message');
    expect(msg.lobby.settings.name).toBe('Abyssal Trench');
    expect(msg.lobby.members).toHaveLength(1);
    expect(msg.lobby.code).toMatch(/^[BCDFGHJKMNPQRTVWXYZ2346789]{6}$/);
  });

  it('carries a rejection back with the operation that failed', async () => {
    const cookie = await account('Skipper');
    const client = await connect(cookie);

    client.send({ t: 'lobby.create', name: 'no' });
    const msg = await client.next('lobby.rejected');

    if (msg.t !== 'lobby.rejected') throw new Error('wrong message');
    expect(msg.op).toBe('lobby.create');
    expect(msg.code).toBe('validation_failed');
  });

  it('broadcasts a join to the members already present', async () => {
    const hostCookie = await account('Skipper');
    const guestCookie = await account('Bosun');
    const host = await connect(hostCookie);
    const guest = await connect(guestCookie);

    host.send({ t: 'lobby.create', name: 'Abyssal Trench' });
    const created = await host.next('lobby.state');
    if (created.t !== 'lobby.state') throw new Error('wrong message');

    guest.send({ t: 'lobby.join', target: { by: 'code', code: created.lobby.code } });
    await guest.next('lobby.state');

    // The host is told without having asked for anything.
    await expect
      .poll(() => host.received.filter((m) => m.t === 'lobby.state').length)
      .toBeGreaterThan(1);
    const latest = host.received.filter((m) => m.t === 'lobby.state').at(-1);
    if (latest?.t !== 'lobby.state') throw new Error('wrong message');
    expect(latest.lobby.members).toHaveLength(2);
  });

  it('tells a kicked player why, over their own socket', async () => {
    const hostCookie = await account('Skipper');
    const guestCookie = await account('Bosun');
    const host = await connect(hostCookie);
    const guest = await connect(guestCookie);

    host.send({ t: 'lobby.create', name: 'Abyssal Trench' });
    const created = await host.next('lobby.state');
    if (created.t !== 'lobby.state') throw new Error('wrong message');
    guest.send({ t: 'lobby.join', target: { by: 'code', code: created.lobby.code } });
    const joined = await guest.next('lobby.state');
    if (joined.t !== 'lobby.state') throw new Error('wrong message');

    const guestId = joined.lobby.members.find((m) => m.username === 'Bosun')?.occupant.accountId;
    host.send({ t: 'lobby.kick', accountId: guestId ?? '' });

    const exit = await guest.next('lobby.exit');
    if (exit.t !== 'lobby.exit') throw new Error('wrong message');
    expect(exit.reason).toBe('kicked');
  });

  it('migrates the host when the host disconnects, without anyone asking', async () => {
    const hostCookie = await account('Skipper');
    const guestCookie = await account('Bosun');
    const host = await connect(hostCookie);
    const guest = await connect(guestCookie);

    host.send({ t: 'lobby.create', name: 'Abyssal Trench' });
    const created = await host.next('lobby.state');
    if (created.t !== 'lobby.state') throw new Error('wrong message');
    guest.send({ t: 'lobby.join', target: { by: 'code', code: created.lobby.code } });
    const joined = await guest.next('lobby.state');
    if (joined.t !== 'lobby.state') throw new Error('wrong message');
    const guestId = joined.lobby.members.find((m) => m.username === 'Bosun')?.occupant.accountId;

    host.socket.close();

    await expect
      .poll(() => {
        const latest = guest.received.filter((m) => m.t === 'lobby.state').at(-1);
        return latest?.t === 'lobby.state' ? latest.lobby.hostAccountId : null;
      })
      .toBe(guestId);
  });

  it('disbands the lobby when the last member disconnects', async () => {
    const cookie = await account('Skipper');
    const client = await connect(cookie);

    client.send({ t: 'lobby.create', name: 'Abyssal Trench' });
    await client.next('lobby.state');
    expect(t.app.lobbies.list({})).toHaveLength(1);

    client.socket.close();

    await expect.poll(() => t.app.lobbies.list({}).length).toBe(0);
  });

  it('tells a reconnecting account about the lobby it is already in', async () => {
    const cookie = await account('Skipper');
    const first = await connect(cookie);

    first.send({ t: 'lobby.create', name: 'Abyssal Trench' });
    const created = await first.next('lobby.state');
    if (created.t !== 'lobby.state') throw new Error('wrong message');

    // A second tab. Membership lives on the account, not the socket, so without state
    // recovery this connection would sit on the menu while the server considers it seated —
    // and every create or join would be refused with `already_in_lobby`.
    const second = await connect(cookie);
    const recovered = await second.next('lobby.state');

    if (recovered.t !== 'lobby.state') throw new Error('wrong message');
    expect(recovered.lobby.id).toBe(created.lobby.id);
    expect(recovered.lobby.hostAccountId).toBe(created.lobby.hostAccountId);
  });

  it('keeps the lobby alive when a tab is replaced, and leaves it when the last one closes', async () => {
    const cookie = await account('Skipper');
    const first = await connect(cookie);

    first.send({ t: 'lobby.create', name: 'Abyssal Trench' });
    await first.next('lobby.state');

    const second = await connect(cookie);
    await second.next('lobby.state');

    // The replaced socket's close must not evict the tab that replaced it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.app.lobbies.list({})).toHaveLength(1);
    expect(t.app.lobbies.lobbyFor(recoveredAccountId(second))).not.toBeNull();

    // Closing the surviving tab does end it.
    second.socket.close();
    await expect.poll(() => t.app.lobbies.list({}).length).toBe(0);
  });

  it('answers the server browser without the caller being in a lobby', async () => {
    const hostCookie = await account('Skipper');
    const browserCookie = await account('Bosun');
    const host = await connect(hostCookie);
    const browser = await connect(browserCookie);

    host.send({ t: 'lobby.create', name: 'Abyssal Trench' });
    await host.next('lobby.state');

    browser.send({ t: 'lobby.list', filter: {} });
    const msg = await browser.next('lobby.list.result');

    if (msg.t !== 'lobby.list.result') throw new Error('wrong message');
    expect(msg.lobbies).toHaveLength(1);
    expect(msg.lobbies[0]?.name).toBe('Abyssal Trench');
    // The browser is not a member, so the code must not be in the bytes it received.
    expect(JSON.stringify(msg)).not.toContain('code');
  });

  it('reports how many players are online alongside the list', async () => {
    const hostCookie = await account('Skipper');
    const browserCookie = await account('Bosun');
    const host = await connect(hostCookie);
    const browser = await connect(browserCookie);

    host.send({ t: 'lobby.create', name: 'Abyssal Trench' });
    await host.next('lobby.state');

    browser.send({ t: 'lobby.list', filter: {} });
    const msg = await browser.next('lobby.list.result');

    // planning/07 §4: an empty list with a player count is honest; without one it reads as
    // broken. Both connected accounts count, whether or not they are in a lobby.
    if (msg.t !== 'lobby.list.result') throw new Error('wrong message');
    expect(msg.playersOnline).toBe(2);
  });

  it('reports zero lobbies and a real player count when nobody is hosting', async () => {
    const cookie = await account('Skipper');
    const client = await connect(cookie);

    client.send({ t: 'lobby.list', filter: {} });
    const msg = await client.next('lobby.list.result');

    if (msg.t !== 'lobby.list.result') throw new Error('wrong message');
    expect(msg.lobbies).toHaveLength(0);
    expect(msg.playersOnline).toBe(1);
  });

  it('joins a lobby found in the browser by its id', async () => {
    const hostCookie = await account('Skipper');
    const browserCookie = await account('Bosun');
    const host = await connect(hostCookie);
    const browser = await connect(browserCookie);

    host.send({ t: 'lobby.create', name: 'Abyssal Trench' });
    await host.next('lobby.state');

    browser.send({ t: 'lobby.list', filter: {} });
    const listed = await browser.next('lobby.list.result');
    if (listed.t !== 'lobby.list.result') throw new Error('wrong message');
    const id = listed.lobbies[0]?.id;
    if (id === undefined) throw new Error('no lobby listed');

    // The browser row carries an id and nothing else that could admit someone, which is
    // why joining from here is by id while a private lobby needs its code.
    browser.send({ t: 'lobby.join', target: { by: 'id', lobbyId: id } });
    const joined = await browser.next('lobby.state');

    if (joined.t !== 'lobby.state') throw new Error('wrong message');
    expect(joined.lobby.members).toHaveLength(2);
  });

  it('still answers pings alongside lobby traffic', async () => {
    const cookie = await account('Skipper');
    const client = await connect(cookie);

    client.send({ t: 'ping', clientTime: 123 });
    const pong = await client.next('pong');

    if (pong.t !== 'pong') throw new Error('wrong message');
    expect(pong.clientTime).toBe(123);
  });

  it('closes the connection on a malformed frame', async () => {
    const cookie = await account('Skipper');
    const client = await connect(cookie);
    const closed = new Promise<void>((resolve) => client.socket.on('close', () => resolve()));

    client.socket.send('not json at all');

    await closed;
    expect(client.socket.readyState).toBe(WebSocket.CLOSED);
  });
});

// ── fleets in a lobby, end to end ───────────────────────────────────────────────

describe('bringing a fleet into a lobby', () => {
  /** Saves a fleet over HTTP and returns its id — the same path the editor uses. */
  async function saveFleet(
    cookie: string,
    name: string,
    hulls: BoatTemplate['hull'][],
  ): Promise<string> {
    const res = await api<FleetResponse>(t.baseUrl, FLEET_ROUTES.collection, {
      method: 'POST',
      cookie,
      body: {
        name,
        boats: hulls.map((hull, i) => ({ name: `S-0${String(i + 1)}`, hull, modules: [] })),
      },
    });
    return res.body.fleet.id;
  }

  /** The latest lobby.state a client received. */
  function latest(client: Client): Extract<Message, { t: 'lobby.state' }> {
    const state = client.received.filter((m) => m.t === 'lobby.state').at(-1);
    if (state?.t !== 'lobby.state') throw new Error('no lobby.state received');
    return state;
  }

  it('prices the fleet from the account, not from anything the client says', async () => {
    const cookie = await account('Skipper');
    const fleetId = await saveFleet(cookie, 'Wolfpack', ['light', 'light']);

    const client = await connect(cookie);
    client.send({ t: 'lobby.create', name: 'Deep Water' });
    await client.next('lobby.state');

    client.send({ t: 'lobby.selectFleet', fleetId });
    await vi.waitUntil(() => latest(client).you.fleet !== null);

    // Two Light hulls at 70 apiece. The number comes from the shared cost function via the
    // denormalised column, which is what the editor showed the player.
    expect(latest(client).you.fleet?.points).toBe(140);
    expect(latest(client).lobby.members[0]?.hasFleet).toBe(true);
  });

  it('never sends one player’s fleet to another', async () => {
    const hostCookie = await account('Skipper');
    const guestCookie = await account('Bosun');
    const fleetId = await saveFleet(hostCookie, 'Silent Service', ['heavy']);

    const host = await connect(hostCookie);
    host.send({ t: 'lobby.create', name: 'Deep Water' });
    const created = await host.next('lobby.state');
    if (created.t !== 'lobby.state') throw new Error('wrong message');

    const guest = await connect(guestCookie);
    guest.send({ t: 'lobby.join', target: { by: 'code', code: created.lobby.code } });
    await guest.next('lobby.state');

    host.send({ t: 'lobby.selectFleet', fleetId });
    await vi.waitUntil(() => latest(guest).lobby.members.some((m) => m.hasFleet));

    // Asserted on every byte the guest's socket ever carried, not on a field: the point is
    // that the fleet name is nowhere in it.
    expect(JSON.stringify(guest.received)).not.toContain('Silent Service');
    expect(latest(guest).you.fleet).toBeNull();
  });

  it('refuses a fleet belonging to another account', async () => {
    const hostCookie = await account('Skipper');
    const otherCookie = await account('Bosun');
    const theirFleet = await saveFleet(otherCookie, 'Not Yours', ['light']);

    const host = await connect(hostCookie);
    host.send({ t: 'lobby.create', name: 'Deep Water' });
    await host.next('lobby.state');

    host.send({ t: 'lobby.selectFleet', fleetId: theirFleet });
    const rejected = await host.next('lobby.rejected');

    if (rejected.t !== 'lobby.rejected') throw new Error('wrong message');
    expect(rejected.code).toBe('not_found');
  });

  it('drops the selection when the fleet is edited past the budget', async () => {
    const cookie = await account('Skipper');
    const fleetId = await saveFleet(cookie, 'Wolfpack', ['light']);

    const client = await connect(cookie);
    client.send({ t: 'lobby.create', name: 'Deep Water' });
    await client.next('lobby.state');
    client.send({ t: 'lobby.selectFleet', fleetId });
    await vi.waitUntil(() => latest(client).you.fleet !== null);
    client.send({ t: 'lobby.setReady', ready: true });
    await vi.waitUntil(() => latest(client).lobby.members[0]?.ready === true);

    // Back to the editor: six Heavies is 1140 points against a 500-point lobby. Selecting
    // cheap and then editing up is the obvious way past a budget checked only on selection.
    await api(t.baseUrl, `${FLEET_ROUTES.item}?id=${fleetId}`, {
      method: 'PUT',
      cookie,
      body: {
        name: 'Wolfpack',
        boats: Array.from({ length: 6 }, (_, i) => ({
          name: `S-0${String(i + 1)}`,
          hull: 'heavy',
          modules: [],
        })),
      },
    });

    await vi.waitUntil(() => latest(client).you.fleet === null);
    expect(latest(client).lobby.members[0]?.hasFleet).toBe(false);
    expect(latest(client).lobby.members[0]?.ready).toBe(false);
  });

  it('drops the selection when the fleet is deleted', async () => {
    const cookie = await account('Skipper');
    const fleetId = await saveFleet(cookie, 'Wolfpack', ['light']);

    const client = await connect(cookie);
    client.send({ t: 'lobby.create', name: 'Deep Water' });
    await client.next('lobby.state');
    client.send({ t: 'lobby.selectFleet', fleetId });
    await vi.waitUntil(() => latest(client).you.fleet !== null);

    await api(t.baseUrl, `${FLEET_ROUTES.item}?id=${fleetId}`, { method: 'DELETE', cookie });

    await vi.waitUntil(() => latest(client).you.fleet === null);
    expect(latest(client).lobby.members[0]?.hasFleet).toBe(false);
  });
});

// ── starting a match, end to end ──────────────────────────────────────────────────

describe('starting a match', () => {
  /** Saves a fleet over HTTP and returns its id — the same path the editor uses. */
  async function saveFleet(
    cookie: string,
    name: string,
    hulls: BoatTemplate['hull'][],
  ): Promise<string> {
    const res = await api<FleetResponse>(t.baseUrl, FLEET_ROUTES.collection, {
      method: 'POST',
      cookie,
      body: {
        name,
        boats: hulls.map((hull, i) => ({ name: `S-0${String(i + 1)}`, hull, modules: [] })),
      },
    });
    return res.body.fleet.id;
  }

  /** The latest lobby.state a client received. */
  function latest(client: Client): Extract<Message, { t: 'lobby.state' }> {
    const state = client.received.filter((m) => m.t === 'lobby.state').at(-1);
    if (state?.t !== 'lobby.state') throw new Error('no lobby.state received');
    return state;
  }

  /** The match setup a client was sent — its own slice, never anyone else's. */
  function setupOf(client: Client): MatchSetup {
    const state = client.received.find((m) => m.t === 'match.state');
    if (state?.t !== 'match.state') throw new Error('no match.state received');
    return state.setup;
  }

  it('broadcasts the start to every member and stores the map it shipped', async () => {
    const hostCookie = await account('Skipper');
    const guestCookie = await account('Bosun');
    const [hostFleet, guestFleet] = [
      await saveFleet(hostCookie, 'Silent Service', ['light']),
      await saveFleet(guestCookie, 'Deep Patrol', ['light']),
    ];

    const host = await connect(hostCookie);
    host.send({ t: 'lobby.create', name: 'Deep Water' });
    const created = await host.next('lobby.state');
    if (created.t !== 'lobby.state') throw new Error('wrong message');

    // Empty, so the assertions below are about the wiring rather than about where a carve
    // happened to leave open water. The dense path is covered by the next test.
    host.send({ t: 'lobby.modify', patch: { mapType: 'empty' } });
    await vi.waitUntil(() => latest(host).lobby.settings.mapType === 'empty');

    const guest = await connect(guestCookie);
    guest.send({ t: 'lobby.join', target: { by: 'code', code: created.lobby.code } });
    await guest.next('lobby.state');

    for (const [client, fleetId] of [
      [host, hostFleet],
      [guest, guestFleet],
    ] as const) {
      client.send({ t: 'lobby.selectFleet', fleetId });
      await vi.waitUntil(() => latest(client).you.fleet !== null);
      client.send({ t: 'lobby.setReady', ready: true });
      // This client's own ready flag, in its own latest copy — not `every`, which would wait
      // on the other member who has not been asked yet.
      await vi.waitUntil(() => latest(client).lobby.members.some((m) => m.ready));
    }

    host.send({ t: 'lobby.start' });

    // Every member hears the one-shot event and then the full payload. The ordering between
    // the two is not guaranteed by the protocol, but a same-connection send is ordered in
    // practice and asserting it here pins the wiring that order depends on.
    for (const client of [host, guest]) {
      const started = await client.next('match.started');
      const state = await client.next('match.state');
      const frame = await client.next('match.view');
      if (started.t !== 'match.started' || state.t !== 'match.state' || frame.t !== 'match.view')
        throw new Error('wrong message');
      expect(started.matchId).toBe(state.matchId);
      expect(state.setup.mode).toBe('objective-capture');
      expect(state.setup.map.mapType).toBe('empty');
      expect(state.setup.map.extents.width).toBeGreaterThan(0);
      // A player gets the frame of the world and nothing inside it (C21, ADR 0002) — and
      // above all not the seed, which reproduces the whole map in one line of shared code.
      expect(state.setup.map.terrain).toBeNull();
      expect('seed' in state.setup.map).toBe(false);

      // One boat each, and each player is told about their own — never the other team's.
      expect(state.setup.fleet).toHaveLength(1);
      expect(state.setup.fleet[0]?.owner).toBe(state.setup.you.accountId);
      expect(state.setup.fleet[0]?.team).toBe(state.setup.you.team);

      // And a first frame, so the HUD has something to draw before any tick has run.
      expect(frame.baseSeq).toBeNull();
      expect(frame.view.boats).toHaveLength(1);
      expect(frame.view.clock.remainingSeconds).toBe(MATCH_DURATION_SECONDS);
    }

    // The two players are on opposite sides, and each was told about their own side only.
    const [hostSetup, guestSetup] = [setupOf(host), setupOf(guest)];
    expect(hostSetup.you.team).not.toBe(guestSetup.you.team);
    expect(hostSetup.fleet[0]?.id).not.toBe(guestSetup.fleet[0]?.id);

    // The server kept the state it built, so a later reconnect can be re-sent it without the
    // match starting again (Q21) — and it holds *both* fleets, which is exactly the ground
    // truth neither client was given.
    const held = t.app.matchStore.find(hostSetup.matchId);
    expect(held?.boats).toHaveLength(2);
    // The server kept the *whole* map, seed and terrain included. What went out was a chart
    // built from it, and the gap between the two is the fog of war.
    expect(held?.map.extents).toEqual(hostSetup.map.extents);
    expect(held?.map.seed).toBeGreaterThanOrEqual(0);
  });

  it('starts on the default map type, which is a carved cave system', async () => {
    const cookie = await account('Skipper');
    const fleetId = await saveFleet(cookie, 'Wolfpack', ['light']);

    const client = await connect(cookie);
    client.send({ t: 'lobby.create', name: 'Deep Water' });
    await client.next('lobby.state');
    client.send({ t: 'lobby.selectFleet', fleetId });
    await vi.waitUntil(() => latest(client).you.fleet !== null);
    client.send({ t: 'lobby.setReady', ready: true });
    await vi.waitUntil(() => latest(client).lobby.members[0]?.ready === true);

    // Dense is the lobby default (planning/06 §3), so this is the path a host who changes
    // nothing takes — worth asserting end to end rather than only on `empty`.
    client.send({ t: 'lobby.start' });
    const state = await client.next('match.state');
    if (state.t !== 'match.state') throw new Error('wrong message');

    expect(state.setup.map.mapType).toBe('dense');
    // The rock exists — it is simply not the player's. The chart they were sent is empty and
    // the store's copy is carved (C21, ADR 0002).
    expect(state.setup.map.terrain).toBeNull();
    const truth = t.app.matchStore.find(state.setup.matchId);
    expect(truth?.map.terrain.obstacles.length).toBeGreaterThan(0);

    // And the boat is in the water, not in the rock. Deployment measures the terrain it was
    // given, so a carved map is the case that could get this wrong.
    const boat = state.setup.fleet[0];
    expect(boat).toBeDefined();
    const ruler = new TerrainRuler(state.setup.map.extents, truth?.map.terrain.obstacles ?? []);
    const frame = await client.next('match.view');
    if (frame.t !== 'match.view') throw new Error('wrong message');
    const at = frame.view.boats[0]?.pos;
    expect(at).toBeDefined();
    expect(ruler.clearanceAt(at?.x ?? 0, at?.y ?? 0)).toBeGreaterThan(0);
  });
});
