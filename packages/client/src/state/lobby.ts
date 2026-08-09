import {
  JsonCodec,
  describeChatProblem,
  normalizeChatText,
  normalizeJoinCode,
  validateChatText,
  type ChatScope,
  type EntityId,
  type LobbyListFilter,
  type LobbyOp,
  type LobbyPosition,
  type LobbySettingsPatch,
  type LobbyState,
  type LobbySummary,
  type Message,
  type SelectedFleet,
} from '@seg/shared';
import { create } from 'zustand';

import { Connection } from '../net/connection.js';
import { useMatch } from './match.js';
import { useNav } from './nav.js';

/**
 * The lobby's connection to the server.
 *
 * Lobby traffic is on the `control` channel and therefore on the WebSocket, permanently
 * (planning/02 §3.1). This is the socket that will later also carry signalling and match
 * control — it is deliberately opened once and kept, rather than per screen.
 */

export type LobbyConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface LobbyRejection {
  readonly op: LobbyOp;
  readonly message: string;
}

interface LobbyStore {
  status: LobbyConnectionStatus;
  /** The lobby this player is in, or `null`. */
  lobby: LobbyState | null;
  /**
   * The fleet *this* player brought. Arrives in the private half of `lobby.state`.
   *
   * Nobody else's selection is knowable from here, by construction — the roster carries only
   * `hasFleet`. See the note on `LobbyStateMessage.you`.
   */
  selfFleet: SelectedFleet | null;
  /** Result of the last `lobby.list`. `null` means "not asked yet", which the browser
   *  screen shows differently from an answered-but-empty list. */
  browse: readonly LobbySummary[] | null;
  /** Accounts connected, from the last `lobby.list`. */
  playersOnline: number;
  /** The last command that failed, cleared on the next successful change. */
  rejection: LobbyRejection | null;
  /** Set when the player was removed by someone else, so the UI can say why. */
  exitNotice: string | null;

  connect: () => Promise<void>;
  disconnect: () => void;
  clearRejection: () => void;
  clearExitNotice: () => void;

  createLobby: (name: string) => Promise<void>;
  joinByCode: (code: string) => Promise<void>;
  joinById: (lobbyId: string) => Promise<void>;
  listLobbies: (filter: LobbyListFilter) => Promise<void>;
  setPosition: (position: LobbyPosition) => void;
  leave: () => void;
  leaveMatch: () => void;
  kick: (accountId: string) => void;
  modify: (patch: LobbySettingsPatch) => void;
  selectFleet: (fleetId: string | null) => void;
  setReady: (ready: boolean) => void;
  startMatch: () => void;
  sendChat: (scope: ChatScope, text: string) => void;
  /** Throw a boat's active sonar switch. The server answers in the next view frame. */
  setActiveSonar: (boat: EntityId, active: boolean) => void;
}

const codec = new JsonCodec();

/** Module-level, not store state: a socket is not something React should diff. */
let connection: Connection | null = null;
let opening: Promise<void> | null = null;
/** Set by a `session.replaced` message, read by the close that follows it. */
let replaced = false;
/** Set by `disconnect()`, so its own close is not reported as a lost connection. */
let closingDeliberately = false;

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export const useLobby = create<LobbyStore>((set, get) => {
  function receive(msg: Message): void {
    switch (msg.t) {
      case 'lobby.state':
        // Once a match has started the player is no longer in the lobby view, and the server
        // still owns the lobby record it began from — a later broadcast (a member's socket
        // dropping, say) must not drag the player out of the match and back to the roster.
        if (useMatch.getState().matchId !== null) return;
        set({ lobby: msg.lobby, selfFleet: msg.you.fleet, rejection: null, exitNotice: null });
        // Entering a lobby is a navigation, and it can be caused by someone else's action
        // (a host migration does not move you, but a join does), so the store drives it
        // rather than the screen that happened to send the command.
        useNav.getState().go('lobby');
        return;

      case 'match.started':
        // The lobby is consumed. Local copies go so nothing left on the roster lingers, and
        // the match store owns everything from here on (state/match.ts).
        set({ lobby: null, selfFleet: null, rejection: null, exitNotice: null });
        useMatch.getState().started(msg.matchId);
        return;

      case 'match.state':
        useMatch.getState().receivedSetup(msg);
        return;

      case 'match.view':
        useMatch.getState().receivedView(msg);
        return;

      case 'chat.message':
        useMatch.getState().receivedChat(msg.entry);
        return;

      case 'chat.rejected':
        useMatch.getState().chatRejected(msg.message);
        return;

      case 'lobby.exit':
        set({
          lobby: null,
          selfFleet: null,
          exitNotice: msg.reason === 'kicked' ? 'The host removed you from that lobby.' : null,
        });
        useNav.getState().go('home');
        return;

      case 'lobby.list.result':
        set({ browse: msg.lobbies, playersOnline: msg.playersOnline });
        return;

      case 'lobby.rejected':
        set({ rejection: { op: msg.op, message: msg.message } });
        return;

      case 'session.replaced':
        // Arrives just before the server closes this socket. Setting the notice here rather
        // than in `onClose` is what distinguishes "you did this" from "the network died".
        replaced = true;
        set({
          exitNotice:
            'You opened SEG in another tab, so this one was disconnected. Only one tab can be connected at a time.',
        });
        return;

      default:
        return;
    }
  }

  function send(msg: Parameters<Connection['send']>[0]): void {
    if (connection === null || !connection.isOpen) {
      set({ rejection: { op: 'lobby.leave', message: 'Not connected to the server.' } });
      return;
    }
    connection.send(msg);
  }

  return {
    status: 'idle',
    lobby: null,
    selfFleet: null,
    browse: null,
    playersOnline: 0,
    rejection: null,
    exitNotice: null,

    async connect() {
      if (connection?.isOpen === true) return;
      if (opening !== null) return opening;

      // Both flags describe *this* socket's eventual close. Reset them here rather than
      // relying on the close that sets them to arrive — `disconnect()` with no live socket
      // fires no close event, and a stale flag would silently mislabel the next one.
      replaced = false;
      closingDeliberately = false;

      set({ status: 'connecting' });

      // Settled from the Connection callbacks below rather than by subscribing: the class
      // already reports both outcomes, and a socket that never opens must reject rather
      // than leave `connect()` pending forever.
      let settle: { resolve: () => void; reject: (error: Error) => void } | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (error?: Error) => {
        if (timer !== undefined) clearTimeout(timer);
        const pending = settle;
        settle = null;
        opening = null;
        if (pending === null) return;
        if (error === undefined) pending.resolve();
        else pending.reject(error);
      };

      const conn = new Connection({
        codec,
        onMessage: receive,
        onStateChange: (state) => {
          if (state === 'connected') {
            set({ status: 'open' });
            finish();
          }
        },
        onClose: () => {
          connection = null;

          // A dropped socket means the server has already removed us from any lobby (there
          // is no lobby reconnect window — see LobbyHandler.detach), so the local copy goes
          // too rather than lingering as a lie.
          const wasInLobby = get().lobby !== null;
          const wasReplaced = replaced;
          const wasDeliberate = closingDeliberately;
          replaced = false;
          closingDeliberately = false;

          set({
            // `disconnect()` already put the store in `idle`, which is the truthful state
            // for a socket we closed on purpose; `closed` is for one that went away.
            ...(wasDeliberate ? {} : { status: 'closed' as const }),
            lobby: null,
            selfFleet: null,
            // Only when the socket died on its own. A replaced tab already has the better
            // message, set by the `session.replaced` handler above.
            ...(wasInLobby && !wasReplaced && !wasDeliberate
              ? { exitNotice: 'Lost the connection to the server, so you left the lobby.' }
              : {}),
          });

          // Leaving the lobby screen mounted with no lobby renders nothing at all — the
          // player's screen simply goes blank. Whatever the reason for the close, the way
          // out is the menu, where the notice above is visible. The same goes for a match:
          // with the socket gone there is no world, and holding the match screen open would
          // show a frozen scope with no way to leave.
          const screen = useNav.getState().screen;
          if (screen === 'lobby' || screen === 'match') {
            useMatch.getState().clear();
            useNav.getState().go('home');
          }

          finish(new Error('Lost the connection to the server.'));
        },
      });

      connection = conn;

      opening = new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
        timer = setTimeout(() => {
          finish(new Error('Timed out connecting to the server.'));
        }, 10_000);
      });

      conn.connect(socketUrl());
      return opening;
    },

    disconnect() {
      // Flagged and cleared *before* closing, so the `onClose` handler above does not
      // report a disconnect we asked for as a connection we lost. Only when there is a
      // socket to close — otherwise no close follows and the flag would outlive its reason.
      closingDeliberately = connection !== null;
      set({ status: 'idle', lobby: null, selfFleet: null, browse: null, exitNotice: null });
      connection?.disconnect();
      connection = null;
    },

    clearRejection: () => set({ rejection: null }),
    clearExitNotice: () => set({ exitNotice: null }),

    async createLobby(name) {
      await get().connect();
      send({ t: 'lobby.create', name });
    },

    async joinByCode(code) {
      await get().connect();
      // Normalized here as well as on the server, so the code the player sees echoed in an
      // error is the one that was actually looked up.
      send({ t: 'lobby.join', target: { by: 'code', code: normalizeJoinCode(code) } });
    },

    async joinById(lobbyId) {
      await get().connect();
      send({ t: 'lobby.join', target: { by: 'id', lobbyId } });
    },

    async listLobbies(filter) {
      await get().connect();
      send({ t: 'lobby.list', filter });
    },

    setPosition: (position) => send({ t: 'lobby.setPosition', position }),
    leave: () => send({ t: 'lobby.leave' }),

    /*
     * Leave a running match (planning/08 §11) — deliberately here, on the store that owns the
     * socket, rather than on `useMatch`, which would have to import this one and close a
     * cycle between the two.
     *
     * `lobby.leave` is the honest signal on the wire today: a match is a generated map plus
     * the lobby it began from (server/match/store.ts), and the server still counts the player
     * as seated there. Walking back to the menu without it leaves them holding a seat they
     * cannot see, and the next `lobby.create` returns `already_in_lobby` with nothing on
     * screen to explain it.
     *
     * Navigation is local rather than waiting for the `lobby.exit` that follows. The player
     * asked to leave; a match screen that lingers for a round trip reads as a dead button,
     * and the exit is idempotent when it lands.
     */
    leaveMatch() {
      send({ t: 'lobby.leave' });
      useMatch.getState().clear();
      useNav.getState().go('home');
    },

    kick: (accountId) => send({ t: 'lobby.kick', accountId }),
    modify: (patch) => send({ t: 'lobby.modify', patch }),

    // Only the id goes up. The server reads the fleet from the account, so what it costs is
    // never something this client asserts — see LobbySelectFleetMessage.
    selectFleet: (fleetId) => send({ t: 'lobby.selectFleet', fleetId }),
    setReady: (ready) => send({ t: 'lobby.setReady', ready }),
    startMatch: () => send({ t: 'lobby.start' }),

    /*
     * Chat, on the socket this store owns — same reasoning as `leaveMatch`.
     *
     * Checked here before it goes, and again on the server, which is the rule everywhere:
     * the local check exists so a player is told instantly, not so the server can trust it.
     * A line the server refuses comes back as `chat.rejected` and lands in the same place.
     */
    sendChat(scope, text) {
      const normalized = normalizeChatText(text);
      const problem = validateChatText(normalized);
      if (problem !== null) {
        useMatch.getState().chatRejected(describeChatProblem(problem));
        return;
      }
      send({ t: 'chat.send', scope, text: normalized });
    },

    /*
     * The first order this client sends — on the socket this store owns, for the same reason
     * chat and `leaveMatch` are here.
     *
     * Nothing is changed locally. The command is a *request*, and the boat's sonar state comes
     * back in the view frame like every other fact about the world; predicting it here would
     * mean the HUD showing a switch thrown that the server may have refused, which is the exact
     * class of lie the authority model exists to prevent (planning/01 §5). At 10 Hz the round
     * trip is under a frame of the player's own display, so there is nothing to hide.
     */
    setActiveSonar(boat, active) {
      send({ t: 'match.setActiveSonar', boat, active });
    },
  };
});
