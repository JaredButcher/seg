/**
 * @vitest-environment jsdom
 *
 * What happens to a tab whose socket is taken away.
 *
 * Two reported bugs live here. A closed socket used to leave the lobby screen mounted with
 * no lobby, which renders nothing at all — the tab simply went blank. And a replaced tab was
 * told only that its connection closed, which is indistinguishable from the network dying
 * even though it was the player's own second tab that caused it.
 *
 * The store is driven through a fake `WebSocket` so the real `connect`/message/close path
 * runs. The server half of the same behaviour is covered in the server's gateway.test.ts.
 */
import { NO_SELF_VIEW, JsonCodec, type LobbyState, type ServerMessage } from '@seg/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLobby } from '../src/state/lobby.js';
import { useNav } from '../src/state/nav.js';

const codec = new JsonCodec();

const LOBBY: LobbyState = {
  id: 'l1',
  code: 'BCDFGH',
  hostAccountId: 'a1',
  settings: {
    name: 'Deep Water',
    maxPlayers: 6,
    mode: 'objective-capture',
    fleetPoints: 500,
    visibility: 'public',
    mapType: 'dense',
    mapSize: 'medium',
  },
  members: [
    {
      occupant: { kind: 'human', accountId: 'a1' },
      username: 'Skipper',
      position: 'team1',
      joinedAt: 0,
      hasFleet: false,
      ready: false,
    },
  ],
  createdAt: 0,
};

/** Enough of the WebSocket surface for `Connection`, with the events driven by hand. */
class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static last: FakeSocket | null = null;

  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Uint8Array[] = [];

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  send(payload: Uint8Array): void {
    this.sent.push(payload);
  }

  close(): void {
    this.fireClose();
  }

  // ── test drivers ──────────────────────────────────────────────────────────
  fireOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(message: ServerMessage): void {
    const bytes = codec.encode(message);
    this.onmessage?.({ data: bytes.buffer.slice(0) as ArrayBuffer });
  }

  fireClose(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }
}

/** Opens the store's connection and returns the socket it created. */
async function connect(): Promise<FakeSocket> {
  const pending = useLobby.getState().connect();
  const socket = FakeSocket.last;
  if (socket === null) throw new Error('no socket was created');
  socket.fireOpen();
  await pending;
  return socket;
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.last = null;
  useNav.setState({ screen: 'home', authTab: 'signIn' });
  useLobby.setState({ lobby: null, status: 'idle', rejection: null, exitNotice: null });
});

afterEach(() => {
  useLobby.getState().disconnect();
  vi.unstubAllGlobals();
});

describe('a socket that closes while the player is in a lobby', () => {
  it('leaves the lobby screen, instead of stranding the tab on a blank page', async () => {
    const socket = await connect();
    socket.deliver({ t: 'lobby.state', lobby: LOBBY, you: NO_SELF_VIEW });
    expect(useNav.getState().screen).toBe('lobby');

    socket.fireClose();

    // LobbyScreen renders nothing when `lobby` is null, so staying on 'lobby' here is a
    // blank page — which is exactly what was reported.
    expect(useLobby.getState().lobby).toBeNull();
    expect(useNav.getState().screen).toBe('home');
  });

  it('says the connection was lost', async () => {
    const socket = await connect();
    socket.deliver({ t: 'lobby.state', lobby: LOBBY, you: NO_SELF_VIEW });

    socket.fireClose();

    expect(useLobby.getState().exitNotice).toMatch(/lost the connection/i);
  });

  it('clears the local lobby, because the server has already dropped the player', async () => {
    const socket = await connect();
    socket.deliver({ t: 'lobby.state', lobby: LOBBY, you: NO_SELF_VIEW });

    socket.fireClose();

    // There is no lobby reconnect window (LobbyHandler.detach), so keeping the local copy
    // would be showing the player a lobby they are no longer in.
    expect(useLobby.getState().lobby).toBeNull();
    expect(useLobby.getState().status).toBe('closed');
  });
});

describe('a socket replaced by another tab', () => {
  it('explains that it was the player’s own second tab', async () => {
    const socket = await connect();
    socket.deliver({ t: 'lobby.state', lobby: LOBBY, you: NO_SELF_VIEW });

    socket.deliver({ t: 'session.replaced' });
    socket.fireClose();

    // Not "lost the connection": that is alarming and wrong, and the two are
    // indistinguishable from the close event alone.
    expect(useLobby.getState().exitNotice).toMatch(/another tab/i);
    expect(useLobby.getState().exitNotice).not.toMatch(/lost the connection/i);
  });

  it('still leaves the lobby screen', async () => {
    const socket = await connect();
    socket.deliver({ t: 'lobby.state', lobby: LOBBY, you: NO_SELF_VIEW });

    socket.deliver({ t: 'session.replaced' });
    socket.fireClose();

    expect(useNav.getState().screen).toBe('home');
  });

  it('does not carry the notice into the next connection', async () => {
    const first = await connect();
    first.deliver({ t: 'session.replaced' });
    first.fireClose();
    expect(useLobby.getState().exitNotice).toMatch(/another tab/i);

    // The player acts again in this tab, which reconnects and replaces the other one.
    const second = await connect();
    second.deliver({ t: 'lobby.state', lobby: LOBBY, you: NO_SELF_VIEW });

    expect(useLobby.getState().exitNotice).toBeNull();
  });
});

describe('a deliberate disconnect', () => {
  it('is not announced as a lost connection', async () => {
    const socket = await connect();
    socket.deliver({ t: 'lobby.state', lobby: LOBBY, you: NO_SELF_VIEW });

    useLobby.getState().disconnect();

    expect(useLobby.getState().exitNotice).toBeNull();
    expect(useLobby.getState().status).toBe('idle');
  });
});

describe('recovering an existing lobby on connect', () => {
  it('shows the lobby the server hands back without the player asking', async () => {
    const socket = await connect();

    // A fresh tab connects and the server immediately sends the lobby it is already in
    // (LobbyHandler.attach). Nothing was requested.
    socket.deliver({ t: 'lobby.state', lobby: LOBBY, you: NO_SELF_VIEW });

    expect(useLobby.getState().lobby?.id).toBe('l1');
    expect(useNav.getState().screen).toBe('lobby');
  });
});

describe('joining a lobby', () => {
  it('stores the lobby the server pushes, with the host’s settings', async () => {
    const socket = await connect();

    // A join command is answered with a full `lobby.state`; the settings it carries are the
    // ones the host configured, including the map type and size.
    socket.deliver({
      t: 'lobby.state',
      lobby: {
        ...LOBBY,
        settings: { ...LOBBY.settings, mode: 'deathmatch', mapType: 'empty', mapSize: 'large' },
      },
      you: NO_SELF_VIEW,
    });

    expect(useLobby.getState().lobby?.settings).toEqual({
      name: 'Deep Water',
      maxPlayers: 6,
      mode: 'deathmatch',
      fleetPoints: 500,
      visibility: 'public',
      mapType: 'empty',
      mapSize: 'large',
    });
    expect(useNav.getState().screen).toBe('lobby');
  });
});

describe('being in a lobby when settings change', () => {
  it('adopts the settings the host broadcasts', async () => {
    const socket = await connect();
    socket.deliver({ t: 'lobby.state', lobby: LOBBY, you: NO_SELF_VIEW });
    expect(useLobby.getState().lobby?.settings.mapType).toBe('dense');
    expect(useLobby.getState().lobby?.settings.mapSize).toBe('medium');

    socket.deliver({
      t: 'lobby.state',
      lobby: { ...LOBBY, settings: { ...LOBBY.settings, mapType: 'sparse', mapSize: 'small' } },
      you: NO_SELF_VIEW,
    });

    expect(useLobby.getState().lobby?.settings).toMatchObject({
      mapType: 'sparse',
      mapSize: 'small',
    });
  });

  it('replaces the whole picture, so the settings and the roster cannot drift', async () => {
    const socket = await connect();
    socket.deliver({ t: 'lobby.state', lobby: LOBBY, you: NO_SELF_VIEW });

    // A settings change arrives as a full state: a new player has joined at the same time.
    const updated = {
      ...LOBBY,
      settings: { ...LOBBY.settings, mapType: 'empty' },
      members: [
        ...LOBBY.members,
        {
          occupant: { kind: 'human', accountId: 'a2' },
          username: 'Guest',
          position: 'team2',
          joinedAt: 1,
          hasFleet: false,
          ready: false,
        },
      ],
    };
    socket.deliver({ t: 'lobby.state', lobby: updated, you: NO_SELF_VIEW });

    const lobby = useLobby.getState().lobby;
    expect(lobby?.settings.mapType).toBe('empty');
    expect(lobby?.members).toHaveLength(2);
    expect(lobby?.members.map((m) => m.username)).toEqual(['Skipper', 'Guest']);
  });
});
