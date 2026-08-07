import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  type ApiErrorBody,
  type AuthenticatedResponse,
  AUTH_ROUTES,
  type LogoutResponse,
  SESSION_COOKIE,
} from '@seg/shared';

import { AuthError, type AuthService, type IssuedSession } from '../../auth/service.js';
import type { Router } from '../router.js';
import {
  clientIp,
  HttpError,
  readCookie,
  readJsonBody,
  sendJson,
  serializeClearedCookie,
  serializeSessionCookie,
  userAgent,
} from '../util.js';

export interface AuthRouteOptions {
  readonly auth: AuthService;
  /** `Secure` on cookies. Off for plain-http local dev, on everywhere else. */
  readonly secureCookies: boolean;
  /** Whether to believe `X-Forwarded-For`. Only true behind our own reverse proxy. */
  readonly trustProxy: boolean;
  /** Injected for tests. */
  readonly clock?: () => number;
}

interface CredentialsBody {
  username: string;
  password: string;
  rememberMe: boolean;
}

/** Extracts credentials without trusting anything about the shape of the payload. */
function readCredentials(body: unknown): CredentialsBody {
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'bad_request', 'Expected a JSON object.');
  }
  const raw = body as Record<string, unknown>;

  if (typeof raw['username'] !== 'string' || typeof raw['password'] !== 'string') {
    throw new HttpError(400, 'bad_request', 'username and password are required strings.');
  }
  if (raw['rememberMe'] !== undefined && typeof raw['rememberMe'] !== 'boolean') {
    throw new HttpError(400, 'bad_request', 'rememberMe must be a boolean.');
  }

  return {
    username: raw['username'],
    password: raw['password'],
    rememberMe: raw['rememberMe'] === true,
  };
}

function setSessionCookie(
  res: ServerResponse,
  session: IssuedSession,
  secure: boolean,
  now: number,
): void {
  const options = session.remember
    ? { secure, maxAgeSeconds: Math.floor((session.expiresAt - now) / 1000) }
    : { secure };
  res.setHeader('set-cookie', serializeSessionCookie(SESSION_COOKIE, session.token, options));
}

function authenticatedBody(
  account: AuthenticatedResponse['account'],
  session: IssuedSession,
): AuthenticatedResponse {
  return {
    account,
    session: { expiresAt: session.expiresAt, remembered: session.remember },
  };
}

export function registerAuthRoutes(router: Router, options: AuthRouteOptions): void {
  const { auth, secureCookies, trustProxy } = options;
  const clock = options.clock ?? (() => Date.now());

  const context = (req: IncomingMessage) => ({
    ip: clientIp(req, trustProxy),
    userAgent: userAgent(req),
    now: clock(),
  });

  router.post(AUTH_ROUTES.signup, async (req, res) => {
    const { username, password, rememberMe } = readCredentials(await readJsonBody(req));
    const ctx = context(req);

    const { account, session } = await auth.signup(username, password, rememberMe, ctx);

    setSessionCookie(res, session, secureCookies, ctx.now);
    sendJson(res, 201, authenticatedBody(account, session));
  });

  router.post(AUTH_ROUTES.login, async (req, res) => {
    const { username, password, rememberMe } = readCredentials(await readJsonBody(req));
    const ctx = context(req);

    const { account, session } = await auth.login(username, password, rememberMe, ctx);

    setSessionCookie(res, session, secureCookies, ctx.now);
    sendJson(res, 200, authenticatedBody(account, session));
  });

  router.get(AUTH_ROUTES.me, async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    const resolved = token === undefined ? undefined : await auth.resolveSession(token, clock());

    if (resolved === undefined) {
      // Clear a cookie that is no longer valid, so the browser stops sending it.
      if (token !== undefined) {
        res.setHeader('set-cookie', serializeClearedCookie(SESSION_COOKIE, secureCookies));
      }
      throw new AuthError('unauthenticated', 'Not signed in.', 401);
    }

    const body: AuthenticatedResponse = {
      account: resolved.account,
      session: { expiresAt: resolved.expiresAt, remembered: resolved.remember },
    };
    sendJson(res, 200, body);
  });

  router.post(AUTH_ROUTES.logout, async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    const ended = token === undefined ? 0 : await auth.logout(token);

    res.setHeader('set-cookie', serializeClearedCookie(SESSION_COOKIE, secureCookies));
    const body: LogoutResponse = { endedSessions: ended };
    sendJson(res, 200, body);
  });

  router.post(AUTH_ROUTES.logoutAll, async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    const resolved = token === undefined ? undefined : await auth.resolveSession(token, clock());

    if (resolved === undefined) {
      throw new AuthError('unauthenticated', 'Not signed in.', 401);
    }

    const ended = await auth.logoutAll(resolved.account.id);
    res.setHeader('set-cookie', serializeClearedCookie(SESSION_COOKIE, secureCookies));
    const body: LogoutResponse = { endedSessions: ended };
    sendJson(res, 200, body);
  });
}

/** Converts a thrown error into the single error shape the contract promises. */
export function toErrorBody(err: unknown): { status: number; body: ApiErrorBody } {
  if (err instanceof AuthError) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.field !== undefined ? { field: err.field } : {}),
          ...(err.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: err.retryAfterSeconds }
            : {}),
        },
      },
    };
  }

  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.code === 'payload_too_large' ? 'payload_too_large' : 'bad_request',
          message: err.message,
        },
      },
    };
  }

  // Never leak an internal message to the client.
  return {
    status: 500,
    body: { error: { code: 'internal_error', message: 'Something went wrong.' } },
  };
}
