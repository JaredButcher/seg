import {
  type ApiErrorBody,
  type AuthenticatedResponse,
  AUTH_ROUTES,
  type LogoutResponse,
  SESSION_COOKIE,
} from '@seg/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REMEMBER_TTL_MS, SESSION_TTL_MS } from '../src/auth/service.js';
import { api, cookieAttributes, cookieValue, startTestApp, type TestApp } from './helpers.js';

const GOOD_PASSWORD = 'correct horse battery staple';

let t: TestApp;

beforeEach(async () => {
  t = await startTestApp();
});

afterEach(async () => {
  await t.close();
});

function signup(username: string, password = GOOD_PASSWORD, rememberMe = false) {
  return api<AuthenticatedResponse & ApiErrorBody>(t.baseUrl, AUTH_ROUTES.signup, {
    method: 'POST',
    body: { username, password, rememberMe },
  });
}

function login(username: string, password = GOOD_PASSWORD, rememberMe = false) {
  return api<AuthenticatedResponse & ApiErrorBody>(t.baseUrl, AUTH_ROUTES.login, {
    method: 'POST',
    body: { username, password, rememberMe },
  });
}

describe('signup', () => {
  it('creates an account and returns it with a session cookie', async () => {
    const res = await signup('Skipper');

    expect(res.status).toBe(201);
    expect(res.body.account.username).toBe('Skipper');
    expect(res.body.account.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.session.remembered).toBe(false);
    expect(res.setCookie).toContain(`${SESSION_COOKIE}=`);
  });

  it('never returns the password or its hash', async () => {
    const res = await signup('Skipper');
    const serialized = JSON.stringify(res.body);

    expect(serialized).not.toContain(GOOD_PASSWORD);
    expect(serialized).not.toContain('argon2');
    expect(serialized).not.toMatch(/hash/i);
  });

  it('collects nothing beyond username, id, and creation time', async () => {
    const res = await signup('Skipper');
    expect(Object.keys(res.body.account).sort()).toEqual(['createdAt', 'id', 'username']);
  });

  it('rejects a duplicate username case-insensitively', async () => {
    await signup('Skipper');
    const res = await signup('SKIPPER');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('username_taken');
    expect(res.body.error.field).toBe('username');
  });

  it('preserves the chosen case', async () => {
    const res = await signup('PlayerOne');
    expect(res.body.account.username).toBe('PlayerOne');
  });

  it('enforces the shared validation rules', async () => {
    const short = await signup('ab');
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe('validation_failed');
    expect(short.body.error.field).toBe('username');

    const badChars = await signup('has space');
    expect(badChars.body.error.field).toBe('username');

    const weak = await signup('Skipper', 'short');
    expect(weak.status).toBe(400);
    expect(weak.body.error.field).toBe('password');
  });

  it('rejects common passwords', async () => {
    const res = await signup('Skipper', 'password123');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('password_too_common');
  });

  it('rejects a malformed body', async () => {
    const missing = await api<ApiErrorBody>(t.baseUrl, AUTH_ROUTES.signup, {
      method: 'POST',
      body: { username: 'Skipper' },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('bad_request');

    const wrongType = await api<ApiErrorBody>(t.baseUrl, AUTH_ROUTES.signup, {
      method: 'POST',
      body: { username: 123, password: GOOD_PASSWORD },
    });
    expect(wrongType.status).toBe(400);
  });

  it('requires a JSON content type, which is what closes CSRF', async () => {
    const res = await api<ApiErrorBody>(t.baseUrl, AUTH_ROUTES.signup, {
      method: 'POST',
      rawBody: JSON.stringify({ username: 'Skipper', password: GOOD_PASSWORD }),
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(415);
  });

  it('rejects an oversized body before buffering it', async () => {
    const res = await api<ApiErrorBody>(t.baseUrl, AUTH_ROUTES.signup, {
      method: 'POST',
      rawBody: JSON.stringify({ username: 'Skipper', password: 'x'.repeat(20_000) }),
    });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });
});

describe('login', () => {
  beforeEach(async () => {
    await signup('Skipper');
  });

  it('accepts correct credentials and issues a new session', async () => {
    const first = await login('Skipper');
    const second = await login('Skipper');

    expect(first.status).toBe(200);
    expect(cookieValue(first.setCookie)).not.toBe(cookieValue(second.setCookie));
  });

  it('accepts the username case-insensitively', async () => {
    const res = await login('sKiPpEr');
    expect(res.status).toBe(200);
    expect(res.body.account.username).toBe('Skipper');
  });

  it('rejects a wrong password', async () => {
    const res = await login('Skipper', 'wrong password entirely');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_credentials');
  });

  it('gives an identical response for unknown user and wrong password', async () => {
    const unknown = await login('NoSuchPerson', 'wrong password entirely');
    const wrong = await login('Skipper', 'wrong password entirely');

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });
});

describe('sessions', () => {
  it('resolves an issued cookie via /me', async () => {
    const created = await signup('Skipper');
    const res = await api<AuthenticatedResponse>(t.baseUrl, AUTH_ROUTES.me, {
      cookie: cookieValue(created.setCookie),
    });

    expect(res.status).toBe(200);
    expect(res.body.account.id).toBe(created.body.account.id);
  });

  it('rejects /me without a cookie', async () => {
    const res = await api<ApiErrorBody>(t.baseUrl, AUTH_ROUTES.me);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('rejects a forged token', async () => {
    const res = await api<ApiErrorBody>(t.baseUrl, AUTH_ROUTES.me, {
      cookie: `${SESSION_COOKIE}=not-a-real-token`,
    });
    expect(res.status).toBe(401);
  });

  it('stores only the hash of the token, never the token', async () => {
    const created = await signup('Skipper');
    const token = cookieValue(created.setCookie).split('=')[1] ?? '';
    expect(token.length).toBeGreaterThan(20);

    const rows = await t.app.db.query<{ token_hash: string }>('SELECT token_hash FROM session');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('expires a plain session after 12 hours', async () => {
    const created = await signup('Skipper', GOOD_PASSWORD, false);
    const cookie = cookieValue(created.setCookie);

    t.advance(SESSION_TTL_MS - 1000);
    expect((await api(t.baseUrl, AUTH_ROUTES.me, { cookie })).status).toBe(200);

    t.advance(2000);
    expect((await api(t.baseUrl, AUTH_ROUTES.me, { cookie })).status).toBe(401);
  });

  it('deletes the row when an expired session is presented', async () => {
    const created = await signup('Skipper');
    const cookie = cookieValue(created.setCookie);

    t.advance(SESSION_TTL_MS + 1000);
    await api(t.baseUrl, AUTH_ROUTES.me, { cookie });

    const rows = await t.app.db.query('SELECT * FROM session');
    expect(rows).toHaveLength(0);
  });
});

describe('keep me logged in', () => {
  it('issues a persistent cookie with Max-Age when remembered', async () => {
    const res = await signup('Skipper', GOOD_PASSWORD, true);
    const attributes = cookieAttributes(res.setCookie);

    expect(res.body.session.remembered).toBe(true);
    expect(attributes.some((a) => a.startsWith('Max-Age='))).toBe(true);
    expect(attributes).toContain('HttpOnly');
    expect(attributes).toContain('SameSite=Lax');
  });

  it('issues a browser-session cookie with no Max-Age when not remembered', async () => {
    const res = await signup('Skipper', GOOD_PASSWORD, false);
    const attributes = cookieAttributes(res.setCookie);

    expect(attributes.some((a) => a.startsWith('Max-Age='))).toBe(false);
    expect(attributes).toContain('HttpOnly');
  });

  it('omits Secure in dev and would set it in production', async () => {
    const res = await signup('Skipper');
    expect(cookieAttributes(res.setCookie)).not.toContain('Secure');
  });

  it('survives far longer than a plain session', async () => {
    const created = await signup('Skipper', GOOD_PASSWORD, true);
    const cookie = cookieValue(created.setCookie);

    t.advance(SESSION_TTL_MS * 2);
    expect((await api(t.baseUrl, AUTH_ROUTES.me, { cookie })).status).toBe(200);
  });

  it('slides the expiry on use, so an active player is never logged out', async () => {
    const created = await signup('Skipper', GOOD_PASSWORD, true);
    const cookie = cookieValue(created.setCookie);

    // Come back every 20 days for 100 days. A 30-day absolute expiry would fail here.
    for (let visit = 0; visit < 5; visit++) {
      t.advance(20 * 24 * 60 * 60_000);
      const res = await api<AuthenticatedResponse>(t.baseUrl, AUTH_ROUTES.me, { cookie });
      expect(res.status, `visit ${visit}`).toBe(200);
    }
  });

  it('still expires after a genuine absence', async () => {
    const created = await signup('Skipper', GOOD_PASSWORD, true);
    const cookie = cookieValue(created.setCookie);

    t.advance(REMEMBER_TTL_MS + 60_000);
    expect((await api(t.baseUrl, AUTH_ROUTES.me, { cookie })).status).toBe(401);
  });

  it('does not write to the database on every request', async () => {
    const created = await signup('Skipper', GOOD_PASSWORD, true);
    const cookie = cookieValue(created.setCookie);

    const before = await t.app.db.queryOne<{ last_used_at: number }>(
      'SELECT last_used_at FROM session',
    );

    t.advance(60_000); // under the 5-minute touch threshold
    await api(t.baseUrl, AUTH_ROUTES.me, { cookie });

    const after = await t.app.db.queryOne<{ last_used_at: number }>(
      'SELECT last_used_at FROM session',
    );
    expect(after?.last_used_at).toBe(before?.last_used_at);
  });
});

describe('logout', () => {
  it('ends the current session and clears the cookie', async () => {
    const created = await signup('Skipper');
    const cookie = cookieValue(created.setCookie);

    const out = await api<LogoutResponse>(t.baseUrl, AUTH_ROUTES.logout, {
      method: 'POST',
      cookie,
      body: {},
    });

    expect(out.status).toBe(200);
    expect(out.body.endedSessions).toBe(1);
    expect(out.setCookie).toContain('Max-Age=0');
    expect((await api(t.baseUrl, AUTH_ROUTES.me, { cookie })).status).toBe(401);
  });

  it('is harmless without a session', async () => {
    const res = await api<LogoutResponse>(t.baseUrl, AUTH_ROUTES.logout, {
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.endedSessions).toBe(0);
  });

  it('logout-all ends every session for the account but leaves others alone', async () => {
    await signup('Skipper');
    await signup('Sonarman');

    const a = cookieValue((await login('Skipper')).setCookie);
    const b = cookieValue((await login('Skipper')).setCookie);
    const other = cookieValue((await login('Sonarman')).setCookie);

    const res = await api<LogoutResponse>(t.baseUrl, AUTH_ROUTES.logoutAll, {
      method: 'POST',
      cookie: a,
      body: {},
    });

    expect(res.status).toBe(200);
    expect(res.body.endedSessions).toBe(3); // signup session + two logins
    expect((await api(t.baseUrl, AUTH_ROUTES.me, { cookie: a })).status).toBe(401);
    expect((await api(t.baseUrl, AUTH_ROUTES.me, { cookie: b })).status).toBe(401);
    expect((await api(t.baseUrl, AUTH_ROUTES.me, { cookie: other })).status).toBe(200);
  });
});

describe('rate limiting', () => {
  it('locks an account after repeated failures and recovers after the lockout', async () => {
    await signup('Skipper');

    for (let i = 0; i < 10; i++) {
      const res = await login('Skipper', 'wrong password entirely');
      expect(res.status, `attempt ${i}`).toBe(401);
    }

    const limited = await login('Skipper');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(limited.body.error.retryAfterSeconds).toBeGreaterThan(0);

    t.advance(15 * 60_000 + 1000);
    expect((await login('Skipper')).status).toBe(200);
  });

  it('clears the failure count on a successful login', async () => {
    await signup('Skipper');

    for (let i = 0; i < 9; i++) await login('Skipper', 'wrong password entirely');
    expect((await login('Skipper')).status).toBe(200);

    for (let i = 0; i < 9; i++) await login('Skipper', 'wrong password entirely');
    expect((await login('Skipper')).status).toBe(200);
  });
});

describe('routing', () => {
  it('404s an unknown path and 405s a wrong method', async () => {
    expect((await api(t.baseUrl, '/api/auth/nope')).status).toBe(404);
    expect((await api(t.baseUrl, AUTH_ROUTES.signup)).status).toBe(405);
  });

  it('keeps /health working', async () => {
    const res = await api<{ status: string }>(t.baseUrl, '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
