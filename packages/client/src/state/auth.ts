import type { AccountSummary, SessionSummary } from '@seg/shared';
import { create } from 'zustand';

import { authApi } from '../api/auth.js';
import { ApiError } from '../api/http.js';

/**
 * `restoring` is a distinct state from `signedOut`, and the distinction matters: on first
 * paint we do not yet know whether the cookie is valid, and flashing the login form at a
 * signed-in player before snapping to the menu looks broken.
 */
export type AuthStatus = 'restoring' | 'signedOut' | 'signedIn';

interface AuthState {
  status: AuthStatus;
  account: AccountSummary | null;
  session: SessionSummary | null;

  /** Called once on mount to turn an existing cookie into a session. */
  restore: () => Promise<void>;
  signup: (username: string, password: string, rememberMe: boolean) => Promise<void>;
  login: (username: string, password: string, rememberMe: boolean) => Promise<void>;
  logout: () => Promise<void>;
  logoutEverywhere: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  status: 'restoring',
  account: null,
  session: null,

  async restore() {
    try {
      const { account, session } = await authApi.me();
      set({ status: 'signedIn', account, session });
    } catch (err) {
      // A 401 here is the normal "not signed in" case, not a failure worth surfacing.
      if (err instanceof ApiError && err.code === 'unauthenticated') {
        set({ status: 'signedOut', account: null, session: null });
        return;
      }
      // Anything else (server down, network) also leaves the player signed out — they can
      // still try to sign in, and the attempt will surface a real error.
      set({ status: 'signedOut', account: null, session: null });
    }
  },

  async signup(username, password, rememberMe) {
    const { account, session } = await authApi.signup({ username, password, rememberMe });
    set({ status: 'signedIn', account, session });
  },

  async login(username, password, rememberMe) {
    const { account, session } = await authApi.login({ username, password, rememberMe });
    set({ status: 'signedIn', account, session });
  },

  async logout() {
    try {
      await authApi.logout();
    } finally {
      // Sign out locally even if the request failed — the alternative is a player stuck
      // looking at a session they believe is gone.
      set({ status: 'signedOut', account: null, session: null });
    }
  },

  async logoutEverywhere() {
    try {
      await authApi.logoutAll();
    } finally {
      set({ status: 'signedOut', account: null, session: null });
    }
  },
}));
