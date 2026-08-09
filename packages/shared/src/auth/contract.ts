/**
 * The HTTP auth contract. Both sides import these types, so a route that changes shape
 * breaks the client at compile time rather than at runtime.
 */

export const AUTH_API_BASE = '/api/auth';

/** Name of the session cookie. HttpOnly — the client never reads it, but tests do. */
export const SESSION_COOKIE = 'seg_session';

export type AuthErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'username_taken'
  | 'password_too_common'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'unauthenticated'
  | 'payload_too_large'
  | 'internal_error';

/** Every non-2xx response from the auth API has this body. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: AuthErrorCode;
    readonly message: string;
    /** Present when the failure is attributable to one input. */
    readonly field?: 'username' | 'password';
    /** Present on `rate_limited`. */
    readonly retryAfterSeconds?: number;
  };
}

/**
 * Account creation. Username and password only — the game holds no other personal
 * information, deliberately (planning/07 §7).
 *
 * `rememberMe` is a session-lifetime preference, not stored personal data.
 */
export interface SignupRequest {
  readonly username: string;
  readonly password: string;
  readonly rememberMe?: boolean;
}

export interface LoginRequest {
  readonly username: string;
  readonly password: string;
  readonly rememberMe?: boolean;
}

/** The public view of an account. There is nothing else to show. */
export interface AccountSummary {
  readonly id: string;
  readonly username: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
}

export interface SessionSummary {
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  /** Whether this session survives a browser restart. */
  readonly remembered: boolean;
}

/** Returned by signup, login, and `GET /me`. */
export interface AuthenticatedResponse {
  readonly account: AccountSummary;
  readonly session: SessionSummary;
}

export interface LogoutResponse {
  /** How many sessions were ended. 1 for logout, N for logout-all. */
  readonly endedSessions: number;
}

export const AUTH_ROUTES = {
  signup: `${AUTH_API_BASE}/signup`,
  login: `${AUTH_API_BASE}/login`,
  logout: `${AUTH_API_BASE}/logout`,
  logoutAll: `${AUTH_API_BASE}/logout-all`,
  me: `${AUTH_API_BASE}/me`,
} as const;
