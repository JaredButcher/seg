import { create } from 'zustand';

/**
 * The screens reachable from the home page. The full inventory is in planning/08 §2;
 * this is the subset that exists today plus the four destinations the home page offers.
 */
export type Screen =
  | 'home'
  | 'auth'
  | 'lobby-create'
  | 'lobby-join'
  | 'lobby-browse'
  /** Inside a lobby. Navigated to by the lobby store when a `lobby.state` arrives. */
  | 'lobby'
  | 'fleet-editor'
  /**
   * Inside a running match. Navigated to by the match store when a `match.started` arrives —
   * never by a click, because no screen has a button that can start a match.
   */
  | 'match'
  /**
   * After one. Navigated to by the match store when `match.results` arrives, for the same reason
   * the match screen is: the end of a match is a broadcast, and the player it happens to is not
   * doing anything at the time.
   */
  | 'results';

/** Which tab the auth screen opens on when it is reached from the home page. */
export type AuthTab = 'signIn' | 'create';

interface NavState {
  screen: Screen;
  authTab: AuthTab;
  go: (screen: Screen) => void;
  goToAuth: (tab: AuthTab) => void;
  goHome: () => void;
}

/**
 * Deliberately not a router.
 *
 * A URL-backed router earns its weight once there are deep links worth sharing — a lobby
 * code, a replay, a profile. Today every screen is one click from home and each carries an
 * explicit back affordance, so a router would be ceremony around a single string. Swapping
 * one in later touches this file and the switch in App.tsx, and nothing else, because no
 * component knows how it was reached.
 */
export const useNav = create<NavState>((set) => ({
  screen: 'home',
  authTab: 'signIn',

  go: (screen) => set({ screen }),
  goToAuth: (tab) => set({ screen: 'auth', authTab: tab }),
  goHome: () => set({ screen: 'home' }),
}));
