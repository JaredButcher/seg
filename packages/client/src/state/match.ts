/**
 * The client's picture of the running match.
 *
 * Deliberately separate from `useLobby`: a `match.started` message means the player has left
 * the lobby view forever, and the two stores must not fight over navigation.
 *
 * Three things arrive and are kept apart, because they change at wildly different rates and
 * have different lifetimes:
 *
 * - **`setups`** — the static half (`match.state`): map, roster, your fleet's stat blocks.
 *   Keyed by match id so a second match — a replay, later — can be added without a reshuffle.
 * - **`views`** — the volatile half (`match.view`), replaced whole on every frame.
 * - **`chat`** — an append-only log, capped.
 *
 * `revision` exists for the renderer. planning/08 §1 forbids a view frame from triggering a
 * React render on the hot path, so the scope does not subscribe to `views`; it polls this
 * counter from its own ticker and redraws when it moves. React subscribes only to the
 * slow-changing slices the HUD panels read.
 */

import {
  CHAT_HISTORY_LIMIT,
  type ChatEntry,
  type MatchId,
  type MatchSetup,
  type MatchStateMessage,
  type MatchViewMessage,
  type MatchViewState,
} from '@seg/shared';
import { create } from 'zustand';

import { useNav } from './nav.js';

interface MatchStore {
  /** The match this client is currently in, or `null`. Drives the match screen. */
  matchId: MatchId | null;
  /** The static half of every match received, keyed by id. */
  setups: Readonly<Record<MatchId, MatchSetup>>;
  /** The latest view frame per match. */
  views: Readonly<Record<MatchId, MatchViewState>>;
  /** The highest view sequence applied per match, so a stale frame is dropped, not applied. */
  seqs: Readonly<Record<MatchId, number>>;
  /** Everything the player is allowed to have heard, oldest first. */
  chat: readonly ChatEntry[];
  /** Why the last line was not sent, cleared when the next one is typed. */
  chatRejection: string | null;
  /** Bumped whenever the world picture changes. Polled by the renderer; never rendered. */
  revision: number;

  /** A match has begun. Sets the current match and navigates to it. */
  started: (matchId: MatchId) => void;
  receivedSetup: (message: MatchStateMessage) => void;
  receivedView: (message: MatchViewMessage) => void;
  receivedChat: (entry: ChatEntry) => void;
  chatRejected: (message: string | null) => void;
  /** The match is over, or the connection died. Returns to the menu. */
  clear: () => void;
}

export const useMatch = create<MatchStore>((set) => ({
  matchId: null,
  setups: {},
  views: {},
  seqs: {},
  chat: [],
  chatRejection: null,
  revision: 0,

  started(matchId) {
    set({ matchId });
    // Navigation is driven by the store, like the lobby's: the start is a broadcast, so the
    // screen that happened to send `lobby.start` is not the only one that has to move.
    useNav.getState().go('match');
  },

  receivedSetup(message) {
    set((state) => ({
      setups: { ...state.setups, [message.matchId]: message.setup },
      revision: state.revision + 1,
    }));
  },

  receivedView(message) {
    set((state) => {
      // The `view` channel is unreliable and sequenced once WebRTC lands (planning/02 §3):
      // a frame that arrives behind one already applied is stale by definition, and applying
      // it would rewind the picture. Dropping it here is the whole of "drop stale".
      if ((state.seqs[message.matchId] ?? 0) >= message.seq) return state;
      return {
        views: { ...state.views, [message.matchId]: message.view },
        seqs: { ...state.seqs, [message.matchId]: message.seq },
        revision: state.revision + 1,
      };
    });
  },

  receivedChat(entry) {
    set((state) => {
      // The server replays a backlog on reconnect, so the same line can arrive twice.
      if (state.chat.some((existing) => existing.id === entry.id)) return state;
      const chat = [...state.chat, entry].sort((a, b) => a.id - b.id);
      return {
        chat: chat.length > CHAT_HISTORY_LIMIT ? chat.slice(-CHAT_HISTORY_LIMIT) : chat,
        chatRejection: null,
      };
    });
  },

  chatRejected(message) {
    set({ chatRejection: message });
  },

  clear() {
    set({ matchId: null, setups: {}, views: {}, seqs: {}, chat: [], chatRejection: null });
  },
}));

// ── selectors ─────────────────────────────────────────────────────────────────────

/** The active match's static half, or `undefined` before `match.state` lands. */
export function activeSetup(state: MatchStore): MatchSetup | undefined {
  return state.matchId === null ? undefined : state.setups[state.matchId];
}

/** The active match's latest frame, or `undefined` before the first one lands. */
export function activeView(state: MatchStore): MatchViewState | undefined {
  return state.matchId === null ? undefined : state.views[state.matchId];
}
