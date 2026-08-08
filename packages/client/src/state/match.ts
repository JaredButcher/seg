/**
 * The client's picture of the running match.
 *
 * Deliberately separate from `useLobby`: a `match.started` message means the player has left
 * the lobby view forever, and the two stores must not fight over navigation. The match store
 * holds the current match id and the payloads received for it (`match.state`), keyed by id so
 * a second match — a replay, later — can be added without a reshuffle.
 */

import type { MatchId, MatchStateMessage } from '@seg/shared';
import { create } from 'zustand';

import { useNav } from './nav.js';

interface MatchStore {
  /** The match this client is currently in, or `null`. Drives the match screen. */
  matchId: MatchId | null;
  /** Every match payload received, keyed by id. The active one is `states[matchId]`. */
  states: Readonly<Record<MatchId, MatchStateMessage>>;

  /** A match has begun. Sets the current match and navigates to it. */
  started: (matchId: MatchId) => void;
  /** A match payload arrived. Stored; the screen renders it when it has one. */
  received: (message: MatchStateMessage) => void;
  /** The match is over, or the connection died. Returns to the menu. */
  clear: () => void;
}

export const useMatch = create<MatchStore>((set) => ({
  matchId: null,
  states: {},

  started(matchId) {
    set({ matchId });
    // Navigation is driven by the store, like the lobby's: the start is a broadcast, so the
    // screen that happened to send `lobby.start` is not the only one that has to move.
    useNav.getState().go('match');
  },

  received(message) {
    set((state) => ({ states: { ...state.states, [message.matchId]: message } }));
  },

  clear() {
    set({ matchId: null, states: {} });
  },
}));
