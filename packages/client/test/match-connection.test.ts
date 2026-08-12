/**
 * @vitest-environment jsdom
 *
 * What happens when a match begins: the client leaves the lobby view, holds the match id,
 * stores the payload, and is not dragged back into the lobby by later broadcasts.
 *
 * Driven through a fake `WebSocket` like lobby-connection.test.ts so the real connect and
 * receive path runs; the server half of the seam is covered in gateway.test.ts.
 */
import {
  buildResults,
  JsonCodec,
  SIM_TICK_HZ,
  type LobbyState,
  type NoiseMapView,
  type ServerMessage,
} from '@seg/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLobby } from '../src/state/lobby.js';
import { useMatch } from '../src/state/match.js';
import { useNav } from '../src/state/nav.js';
import { matchFixture } from './match-fixture.js';

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
    mapType: 'empty',
    mapSize: 'medium',
    debugMode: false,
  },
  members: [
    {
      occupant: { kind: 'human', accountId: 'a1' },
      username: 'Skipper',
      position: 'team1',
      joinedAt: 0,
      hasFleet: true,
      ready: true,
    },
  ],
  createdAt: 0,
};

/** Enough of the WebSocket surface for `Connection`, with the events driven by hand. */
class FakeSocket {
  static readonly OPEN = 1;
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

  fireOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(message: ServerMessage): void {
    const bytes = codec.encode(message);
    this.onmessage?.({ data: bytes.buffer.slice(0) as ArrayBuffer });
  }

  fireClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }
}

/** What the client actually put on the wire, decoded with the codec the server reads it with. */
function sentMessages(socket: FakeSocket): unknown[] {
  return socket.sent.map((bytes) => codec.decode(bytes));
}

async function connect(): Promise<FakeSocket> {
  const pending = useLobby.getState().connect();
  const socket = FakeSocket.last;
  if (socket === null) throw new Error('no socket was created');
  socket.fireOpen();
  await pending;
  return socket;
}

const FIXTURE = matchFixture();
/** A finished match, built through the projection like every other fixture here. */
const RESULTS = buildResults(
  FIXTURE.state,
  { winner: 'team1', reason: 'wipe' },
  new Map(),
  SIM_TICK_HZ,
);

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.last = null;
  useNav.setState({ screen: 'home', authTab: 'signIn' });
  useLobby.setState({
    lobby: null,
    status: 'idle',
    rejection: null,
    exitNotice: null,
    rejoinable: null,
  });
  useMatch.getState().clear();
});

afterEach(() => {
  useLobby.getState().disconnect();
  useMatch.getState().clear();
  vi.unstubAllGlobals();
});

describe('a match begins', () => {
  it('navigates to the match screen and drops the lobby view', async () => {
    const socket = await connect();
    socket.deliver({ t: 'lobby.state', lobby: LOBBY, you: { fleet: null } });
    expect(useNav.getState().screen).toBe('lobby');

    socket.deliver({ t: 'match.started', matchId: 'm1' });

    // The lobby is consumed: the local copy goes and the match screen takes over.
    expect(useNav.getState().screen).toBe('match');
    expect(useMatch.getState().matchId).toBe('m1');
    expect(useLobby.getState().lobby).toBeNull();
  });

  it('stores the match payload against the match id', async () => {
    const socket = await connect();
    socket.deliver({ t: 'match.state', matchId: 'm1', setup: FIXTURE.setup });
    socket.deliver({
      t: 'match.view',
      matchId: 'm1',
      seq: 4,
      tick: 0,
      baseSeq: null,
      view: FIXTURE.view,
    });

    expect(useMatch.getState().setups['m1']?.map).toEqual(FIXTURE.setup.map);
    expect(useMatch.getState().views['m1']?.boats).toHaveLength(FIXTURE.view.boats.length);
  });

  it('leaves the match screen alone when a later lobby broadcast arrives', async () => {
    const socket = await connect();
    socket.deliver({ t: 'match.started', matchId: 'm1' });
    expect(useNav.getState().screen).toBe('match');

    // The server still owns the lobby the match began from, so a member leaving can still
    // cause a broadcast. It must not drag the player out of the match and back to the roster.
    socket.deliver({ t: 'lobby.state', lobby: LOBBY, you: { fleet: null } });

    expect(useNav.getState().screen).toBe('match');
    expect(useLobby.getState().lobby).toBeNull();
  });

  it('moves to the results when the match ends, keeping what it already had', async () => {
    const socket = await connect();
    socket.deliver({ t: 'match.started', matchId: 'm1' });
    socket.deliver({ t: 'match.state', matchId: 'm1', setup: FIXTURE.setup });

    socket.deliver({ t: 'match.results', matchId: 'm1', results: RESULTS });

    expect(useNav.getState().screen).toBe('results');
    expect(useMatch.getState().results?.winner).toBe('team1');
    // The setup is still in hand: the results screen reads the viewer's own side off it, and
    // the last view frame is what the Reveal will eventually be built on.
    expect(useMatch.getState().setups['m1']).toBeTruthy();
  });

  it('ignores results for a match this client is not in', async () => {
    const socket = await connect();
    socket.deliver({ t: 'match.started', matchId: 'm1' });

    socket.deliver({ t: 'match.results', matchId: 'other', results: RESULTS });

    expect(useNav.getState().screen).toBe('match');
    expect(useMatch.getState().results).toBeNull();
  });

  it('returns to the menu if the socket dies mid-match', async () => {
    const socket = await connect();
    socket.deliver({ t: 'match.started', matchId: 'm1' });

    socket.fireClose();

    expect(useNav.getState().screen).toBe('home');
    expect(useMatch.getState().matchId).toBeNull();
  });
});

describe('leaving a match', () => {
  it('tells the server before it moves the player', async () => {
    const socket = await connect();
    socket.deliver({ t: 'lobby.state', lobby: LOBBY, you: { fleet: null } });
    socket.deliver({ t: 'match.started', matchId: 'm1' });
    socket.sent.length = 0;

    useLobby.getState().leaveMatch();

    // `lobby.leave` is the wire's only "I am done here" today: the server still counts the
    // player as seated in the lobby the match began from. Without it they walk back to the
    // menu holding an invisible seat, and the next create returns `already_in_lobby`.
    expect(sentMessages(socket)).toEqual([{ t: 'lobby.leave' }]);
  });

  it('drops the match and goes home without waiting for the exit to come back', async () => {
    const socket = await connect();
    socket.deliver({ t: 'match.started', matchId: 'm1' });
    socket.deliver({ t: 'match.state', matchId: 'm1', setup: FIXTURE.setup });

    useLobby.getState().leaveMatch();

    expect(useMatch.getState().matchId).toBeNull();
    expect(useMatch.getState().setups).toEqual({});
    expect(useNav.getState().screen).toBe('home');
  });

  it('is unbothered by the exit broadcast that follows', async () => {
    const socket = await connect();
    socket.deliver({ t: 'match.started', matchId: 'm1' });
    useLobby.getState().leaveMatch();

    socket.deliver({ t: 'lobby.exit', reason: 'left' });

    expect(useNav.getState().screen).toBe('home');
    expect(useLobby.getState().exitNotice).toBeNull();
  });
});

describe('rejoining a match', () => {
  it('offers a rejoin when the server says one is there', async () => {
    const socket = await connect();

    socket.deliver({ t: 'match.rejoinable', matchId: 'm1', lobbyName: 'Deep Water' });

    expect(useLobby.getState().rejoinable).toEqual({ matchId: 'm1', lobbyName: 'Deep Water' });
  });

  it('sends match.rejoin and returns to the match screen', async () => {
    const socket = await connect();
    socket.deliver({ t: 'match.rejoinable', matchId: 'm1', lobbyName: 'Deep Water' });

    useLobby.getState().rejoinMatch();

    expect(sentMessages(socket)).toEqual([{ t: 'match.rejoin' }]);
    expect(useLobby.getState().rejoinable).toBeNull();
    expect(useMatch.getState().matchId).toBe('m1');
    expect(useNav.getState().screen).toBe('match');
  });

  it('does nothing when there is nothing to rejoin', async () => {
    const socket = await connect();

    useLobby.getState().rejoinMatch();

    expect(sentMessages(socket)).toEqual([]);
    expect(useNav.getState().screen).toBe('home');
  });

  it('is dropped on entering a different lobby', async () => {
    const socket = await connect();
    socket.deliver({ t: 'match.rejoinable', matchId: 'm1', lobbyName: 'Deep Water' });

    socket.deliver({ t: 'lobby.state', lobby: LOBBY, you: { fleet: null } });

    expect(useLobby.getState().rejoinable).toBeNull();
  });

  it('is dropped on starting a new match', async () => {
    const socket = await connect();
    socket.deliver({ t: 'match.rejoinable', matchId: 'm1', lobbyName: 'Deep Water' });

    socket.deliver({ t: 'match.started', matchId: 'm2' });

    expect(useLobby.getState().rejoinable).toBeNull();
  });

  it('clears the offer when the abandoned match ends, without leaving the menu', async () => {
    const socket = await connect();
    socket.deliver({ t: 'match.rejoinable', matchId: 'm1', lobbyName: 'Deep Water' });

    socket.deliver({ t: 'match.results', matchId: 'm1', results: RESULTS });

    expect(useLobby.getState().rejoinable).toBeNull();
    // Sitting on the menu with nothing tracked, not yanked onto a results screen for a match
    // this tab was not watching.
    expect(useNav.getState().screen).toBe('home');
    expect(useMatch.getState().matchId).toBeNull();
  });

  it('still adopts results for a fresh reconnect that never tracked a rejoinable match', async () => {
    // The other existing path into `match.results` — a tab that reconnects after the match it
    // was in has already ended, and never had a chance to hear about it any other way.
    const socket = await connect();

    socket.deliver({ t: 'match.results', matchId: 'm1', results: RESULTS });

    expect(useNav.getState().screen).toBe('results');
    expect(useMatch.getState().matchId).toBe('m1');
  });
});

describe('commanding a boat', () => {
  /** Seated in a match with the socket clean, ready to send. */
  async function inMatch(): Promise<FakeSocket> {
    const socket = await connect();
    socket.deliver({ t: 'match.started', matchId: 'm1' });
    socket.deliver({ t: 'match.state', matchId: 'm1', setup: FIXTURE.setup });
    socket.sent.length = 0;
    return socket;
  }

  const boat = FIXTURE.setup.fleet[0]!.id;

  it('orders a boat to a point', async () => {
    const socket = await inMatch();
    useLobby.getState().orderBoat(boat, { x: 10, y: 20 }, false);

    expect(sentMessages(socket)).toEqual([
      { t: 'nav.order', boat, to: { x: 10, y: 20 }, queue: false },
    ]);
  });

  it('queues a leg when the order is a shift-click', async () => {
    const socket = await inMatch();
    useLobby.getState().orderBoat(boat, { x: 30, y: 40 }, true);

    expect(sentMessages(socket)).toEqual([
      { t: 'nav.order', boat, to: { x: 30, y: 40 }, queue: true },
    ]);
  });

  it('cancels a boat’s orders', async () => {
    const socket = await inMatch();
    useLobby.getState().cancelOrders(boat);

    expect(sentMessages(socket)).toEqual([{ t: 'nav.cancel', boat }]);
  });

  it('sets a boat’s throttle notch', async () => {
    const socket = await inMatch();
    useLobby.getState().setThrottle(boat, 'flank');

    expect(sentMessages(socket)).toEqual([{ t: 'nav.throttle', boat, notch: 'flank' }]);
  });

  it('refuses a command while disconnected, like any send', async () => {
    useLobby.setState({ lobby: null, status: 'idle', rejection: null, exitNotice: null });
    useLobby.getState().orderBoat(boat, { x: 10, y: 20 }, false);

    expect(useLobby.getState().rejection).not.toBeNull();
  });
});

describe('the debug noise overlay', () => {
  /** Seated in a match with the socket clean, ready to send. */
  async function inMatch(): Promise<FakeSocket> {
    const socket = await connect();
    socket.deliver({ t: 'match.started', matchId: 'm1' });
    socket.deliver({ t: 'match.state', matchId: 'm1', setup: FIXTURE.setup });
    socket.sent.length = 0;
    return socket;
  }

  const MAP: NoiseMapView = {
    cols: 2,
    rows: 2,
    sampleSize: 40,
    floor: 0,
    step: 2,
    runs: [0, 3, 20, 1],
  };

  it('asks for the overlay and switches it off again', async () => {
    const socket = await inMatch();
    useLobby.getState().setDebugNoise(true);
    useLobby.getState().setDebugNoise(false);

    expect(sentMessages(socket)).toEqual([
      { t: 'debug.setNoise', enabled: true },
      { t: 'debug.setNoise', enabled: false },
    ]);
  });

  it('holds the latest heatmap and bumps its own counter, not the view revision', async () => {
    const socket = await inMatch();
    const before = useMatch.getState().revision;

    socket.deliver({ t: 'debug.noise', matchId: 'm1', tick: 40, map: MAP });

    expect(useMatch.getState().noise).toEqual(MAP);
    expect(useMatch.getState().noiseRevision).toBe(1);
    // The scope redraws the fleet off `revision` and the overlay off `noiseRevision`. Sharing one
    // counter would repaint a texture on every view frame that did not carry a heatmap.
    expect(useMatch.getState().revision).toBe(before);
  });

  it('drops a heatmap for a match this client is not in', async () => {
    const socket = await inMatch();

    socket.deliver({ t: 'debug.noise', matchId: 'other', tick: 40, map: MAP });

    expect(useMatch.getState().noise).toBeNull();
    expect(useMatch.getState().noiseRevision).toBe(0);
  });
});
