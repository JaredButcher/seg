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
 * - **`field`** — a debug acoustic field (`debug.field`), which no ordinary match ever receives.
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
  type DebugFieldMessage,
  type EntityId,
  type MatchId,
  type MatchSetup,
  type MatchResults,
  type MatchResultsMessage,
  type MatchStateMessage,
  type MatchViewMessage,
  type MatchViewState,
  type FieldMapView,
} from '@seg/shared';
import { create } from 'zustand';

import { SonarPicture } from '../render/picture.js';
import { useNav } from './nav.js';

/**
 * The tube a boat is on before anyone has said otherwise: the first.
 *
 * Named rather than written as a bare `0` because it is the answer to two questions that only
 * happen to share a number — where a boat starts a match, and what an absent entry in `armedTube`
 * means — and both of them are read in more than one file.
 */
export const FIRST_TUBE = 0;

interface MatchStore {
  /** The match this client is currently in, or `null`. Drives the match screen. */
  matchId: MatchId | null;
  /** The static half of every match received, keyed by id. */
  setups: Readonly<Record<MatchId, MatchSetup>>;
  /** The latest view frame per match. */
  views: Readonly<Record<MatchId, MatchViewState>>;
  /** The highest view sequence applied per match, so a stale frame is dropped, not applied. */
  seqs: Readonly<Record<MatchId, number>>;
  /**
   * How the current match ended, or `null` while it is still being played.
   *
   * Not keyed by match id like the two halves above, because unlike them it is not something a
   * second match could be holding at the same time: it belongs to the match this client is in,
   * and `started` clears it. It is also the one payload that is the same for everyone — the fog
   * lifts at the end (`@seg/shared/match/results`).
   */
  results: MatchResults | null;
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
   * The latest acoustic debug field, or `null` — which is the normal state, because it only
   * arrives for a debug connection that asked for one (`debug/console.ts`, `seg.field`).
   *
   * Replaced whole rather than folded, unlike the picture beside it: a frame *is* the whole field,
   * there is nothing to accumulate, and the object is small enough (a run-length encoded payload)
   * that swapping the reference costs nothing. It also carries its own label and domain, so the
   * overlay and its colour key relabel themselves when a different field is asked for.
   */
  field: FieldMapView | null;
  /**
   * Bumped whenever `field` changes, and read by the renderer the way `revision` is.
   *
   * Its own counter rather than a bump of `revision`, because the two move at different rates and
   * cause different work: a view frame redraws the fleet at 10 Hz, and a field arrives at 2 Hz and
   * repaints a texture. Sharing one counter would make every view frame repaint the overlay.
   */
  fieldRevision: number;
  /**
   * The boat the number keys last picked, or `null`.
   *
   * Purely local, and deliberately not on the wire: selection is which boat *this player's*
   * next order would go to, so the server has no use for it and no other client may see it.
   * It survives view frames because it is keyed on the boat's id rather than its row.
   */
  selected: EntityId | null;
  /**
   * Which single tube each boat will fire next, keyed by boat id. A boat with no entry is on its
   * first tube, which is where every boat starts a match.
   *
   * Sub-selection, one level below the boat selection, and local for the same reason: it is a
   * fact about what *this player's* next gesture means, so the server has no use for it and no
   * other client may see it.
   *
   * **Exactly one tube, and there is always one.** A salvo used to be a set the player built with
   * ctrl+number and emptied by firing; it is now a single tube that space fires and then steps
   * along, wrapping at the end (`MatchScreen#onFire`). That turns the whole weapons interface into
   * one rhythm — space, space, space walks the boat's tubes in order — instead of a set that has
   * to be rebuilt between every shot.
   *
   * **Keyed by boat, so the choice survives switching away and back.** A tube index means a
   * different tube on a different boat, which is why the old flat set had to be cleared whenever
   * the selection moved; a map keyed on the boat says the same thing without throwing anything
   * away, so a player who has walked a Heavy round to its fourth tube still has it there after a
   * detour to a Light three rows down.
   */
  armedTube: Readonly<Record<EntityId, number>>;

  /** A match has begun. Sets the current match and navigates to it. */
  started: (matchId: MatchId) => void;
  receivedSetup: (message: MatchStateMessage) => void;
  receivedView: (message: MatchViewMessage) => void;
  /** One frame of a debug acoustic field (`debug.field`). */
  receivedField: (message: DebugFieldMessage) => void;
  /**
   * Drop the field, taking the overlay and its colour key off the scope with it.
   *
   * Called by the console when the overlay is switched off, and when a *different* field is asked
   * for — the old one must not sit there wearing the new one's key while the first payload is in
   * flight. The server stopping its sends is not enough on its own: a frame already applied stays
   * applied, so without this the overlay would freeze on the last field it was sent rather than
   * disappear, which is the one reading a stale measurement must never give.
   */
  clearField: () => void;
  /** The match is over. Keeps everything and shows the results screen. */
  receivedResults: (message: MatchResultsMessage) => void;
  receivedChat: (entry: ChatEntry) => void;
  chatRejected: (message: string | null) => void;
  /** Pick the boat the next order would go to, or `null` to pick nothing. */
  select: (boat: EntityId | null) => void;
  /** Point a boat at one of its tubes — ctrl+number. */
  selectTube: (boat: EntityId, index: number) => void;
  /**
   * Step a boat along its `count` tubes, wrapping at both ends. What firing does, and what the
   * sideways arrow keys do without firing.
   *
   * The count is the caller's because the store has no idea how many tubes a hull has — that is
   * on the view frame (`MatchViewState.own`), and a store that reached into the frames to find out
   * would be re-deriving on every keypress something the panel already has in hand.
   */
  cycleTube: (boat: EntityId, count: number, step: number) => void;
  /** The match is over, or the connection died. Returns to the menu. */
  clear: () => void;
}

export const useMatch = create<MatchStore>((set, get) => ({
  matchId: null,
  setups: {},
  views: {},
  seqs: {},
  results: null,
  chat: [],
  chatRejection: null,
  revision: 0,
  picture: null,
  field: null,
  fieldRevision: 0,
  selected: null,
  armedTube: {},

  started(matchId) {
    // Cleared rather than carried: the ids are per-match, so a stale one would either name
    // nothing or, worse, name a different boat in the new match. The results go with them — a
    // rematch that opened on the last match's scoreboard would be a rematch nobody could play.
    // An empty tube map is every boat on its first tube, which is where a match begins.
    set({ matchId, selected: null, armedTube: {}, results: null });
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

  receivedField(message) {
    // Dropped for a match this client is not in, the same way a stale view frame is: the overlay
    // is drawn over one map's extents and a field from another would be nonsense at best.
    // Unsequenced, unlike `match.view` — an out-of-order field is one frame of a debug overlay
    // half a second stale, which is not worth a watermark to protect against.
    if (get().matchId !== message.matchId) return;
    set((state) => ({ field: message.map, fieldRevision: state.fieldRevision + 1 }));
  },

  clearField() {
    set((state) =>
      state.field === null ? state : { field: null, fieldRevision: state.fieldRevision + 1 },
    );
  },

  /*
   * The end of the match.
   *
   * Everything else is kept rather than cleared. The results screen is not a different session:
   * the setup it names the boats from is the one already here, and a player who leaves it does so
   * through `clear` like they always have. Keeping the view frames also means the last picture of
   * the ocean is still in hand the day the Reveal (planning/06 §5) is built on top of it.
   *
   * Ignores results for a match this client is not in — a stale message from a match it already
   * left, which the reconnect path can produce — because navigating on one would drop the player
   * out of whatever they are doing now.
   */
  receivedResults(message) {
    // A match this client is not in. The reconnect path can produce one — the server tells a
    // returning connection about whatever match its account is in, which need not be the one this
    // tab was watching — and navigating on it would drop the player out of what they are doing.
    const current = get().matchId;
    if (current !== null && current !== message.matchId) return;
    // Adopted when there is none, which is the tab that reconnected after the match ended: it was
    // never sent `match.started`, so this is the first thing that names the match to it.
    set({ matchId: message.matchId, results: message.results });
    useNav.getState().go('results');
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
    // The tube selections stay exactly where they are: they are keyed by boat, so switching away
    // cannot make one of them mean the wrong tube, and coming back finds the boat as it was left.
    set((state) => (state.selected === boat ? state : { selected: boat }));
  },

  selectTube(boat, index) {
    set((state) =>
      state.armedTube[boat] === index
        ? state
        : { armedTube: { ...state.armedTube, [boat]: index } },
    );
  },

  cycleTube(boat, count, step) {
    if (count <= 0) return;
    set((state) => {
      const current = state.armedTube[boat] ?? FIRST_TUBE;
      // Wrapped in both directions, and the double modulo is what makes a step of −1 off the
      // first tube land on the last rather than on −1. It also quietly repairs an index that has
      // fallen past the end of a boat's tubes.
      const next = (((current + step) % count) + count) % count;
      return next === current ? state : { armedTube: { ...state.armedTube, [boat]: next } };
    });
  },

  clear() {
    set({
      matchId: null,
      setups: {},
      views: {},
      seqs: {},
      results: null,
      chat: [],
      chatRejection: null,
      picture: null,
      field: null,
      fieldRevision: 0,
      selected: null,
      armedTube: {},
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

/**
 * The tube a boat will fire next — its remembered choice, or the first tube if it has none.
 *
 * A function rather than a raw read of `armedTube[boat]`, because "no entry yet" and "on the first
 * tube" are the same state and every caller would otherwise have to remember that. Returns
 * `FIRST_TUBE` for no boat at all, which no caller acts on: the firing paths all check the
 * selection first.
 */
export function armedTubeOf(state: MatchStore, boat: EntityId | null): number {
  return boat === null ? FIRST_TUBE : (state.armedTube[boat] ?? FIRST_TUBE);
}
