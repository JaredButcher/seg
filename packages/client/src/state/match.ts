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
 *
 * **`picture` is the fourth thing, and it is deliberately not immutable.** A view frame carries
 * the *difference* in what the team has heard; the accumulated total lives in a mutable
 * `SonarPicture` that the renderer polls (`render/picture.ts`). Replacing it on every frame
 * would mean copying a chart of a hundred thousand squares ten times a second to satisfy a
 * convention no one here benefits from — the renderer does not subscribe, and nothing else
 * reads it.
 */

import {
  CHAT_HISTORY_LIMIT,
  type ChatEntry,
  type EntityId,
  type MatchId,
  type MatchSetup,
  type MatchStateMessage,
  type MatchViewMessage,
  type MatchViewState,
} from '@seg/shared';
import { create } from 'zustand';

import { SonarPicture } from '../render/picture.js';
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
  /**
   * Everything the team has heard, accumulated. Mutable, and mutated in place — see the header.
   *
   * `null` until `match.state` lands, because it is sized from the map's extents. A spectator
   * gets one too and it stays empty: they are looking at ground truth and have no sonar.
   */
  picture: SonarPicture | null;
  /**
   * The boat the number keys last picked, or `null`.
   *
   * Purely local, and deliberately not on the wire: selection is which boat *this player's*
   * next order would go to, so the server has no use for it and no other client may see it.
   * It survives view frames because it is keyed on the boat's id rather than its row.
   */
  selected: EntityId | null;

  /** A match has begun. Sets the current match and navigates to it. */
  started: (matchId: MatchId) => void;
  receivedSetup: (message: MatchStateMessage) => void;
  receivedView: (message: MatchViewMessage) => void;
  receivedChat: (entry: ChatEntry) => void;
  chatRejected: (message: string | null) => void;
  /** Pick the boat the next order would go to, or `null` to pick nothing. */
  select: (boat: EntityId | null) => void;
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
  picture: null,
  selected: null,

  started(matchId) {
    // Cleared rather than carried: the ids are per-match, so a stale one would either name
    // nothing or, worse, name a different boat in the new match.
    set({ matchId, selected: null });
    // Navigation is driven by the store, like the lobby's: the start is a broadcast, so the
    // screen that happened to send `lobby.start` is not the only one that has to move.
    useNav.getState().go('match');
  },

  receivedSetup(message) {
    set((state) => ({
      setups: { ...state.setups, [message.matchId]: message.setup },
      // A fresh picture, sized from the map. Reconnecting re-sends `match.state`, and the
      // server re-sends the whole chart to a connection it has forgotten, so starting empty
      // here is correct rather than lossy — the two halves of that agreement are
      // `MatchHandler.attach` and this line.
      picture: new SonarPicture(message.setup.map.extents),
      revision: state.revision + 1,
    }));
  },

  receivedView(message) {
    set((state) => {
      // The `view` channel is unreliable and sequenced once WebRTC lands (planning/02 §3):
      // a frame that arrives behind one already applied is stale by definition, and applying
      // it would rewind the picture. Dropping it here is the whole of "drop stale".
      if ((state.seqs[message.matchId] ?? 0) >= message.seq) return state;
      // Folded in place. `picture` keeps its identity across frames on purpose: the renderer
      // holds the same object and polls it, so replacing it would tear down the chart layer.
      state.picture?.apply(message.view.vision, now());
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

  select(boat) {
    set({ selected: boat });
  },

  clear() {
    set({
      matchId: null,
      setups: {},
      views: {},
      seqs: {},
      chat: [],
      chatRejection: null,
      picture: null,
      selected: null,
    });
  },
}));

/**
 * A monotonic millisecond clock for the fades.
 *
 * `performance.now` where it exists, `Date.now` where it does not — jsdom has both, but a test
 * environment without a performance timeline should still be able to seat a frame. Neither is
 * authoritative for anything: the picture's fades are presentation, and everything the *game*
 * measures is measured in simulation ticks (planning/02 §5).
 */
function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

// ── selectors ─────────────────────────────────────────────────────────────────────

/** The active match's static half, or `undefined` before `match.state` lands. */
export function activeSetup(state: MatchStore): MatchSetup | undefined {
  return state.matchId === null ? undefined : state.setups[state.matchId];
}

/** The active match's latest frame, or `undefined` before the first one lands. */
export function activeView(state: MatchStore): MatchViewState | undefined {
  return state.matchId === null ? undefined : state.views[state.matchId];
}
