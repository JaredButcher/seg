import {
  type AccountSummary,
  type AuthErrorCode,
  describeProblem,
  normalizeUsername,
  usernameKey,
  validatePassword,
  validateUsername,
} from '@seg/shared';

import type { AccountRow, Repositories } from '../db/index.js';
import { isCommonPassword } from './common-passwords.js';
import { hashPassword, verifyPassword } from './password.js';
import { IP_LIMITS, RateLimiter, USERNAME_LIMITS } from './rate-limit.js';
import { generateSessionToken, hashSessionToken, newAccountId } from './tokens.js';

/** Sessions that survive a browser restart. Slides on use. */
export const REMEMBER_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days
/** Sessions that do not. Absolute, no sliding. */
export const SESSION_TTL_MS = 12 * 60 * 60_000; // 12 hours

/**
 * A remembered session is only extended if this much time has passed since it was last
 * extended. Without the threshold every authenticated request writes to `session`, which
 * on SQLite means taking the write lock on a read-only operation.
 */
const SLIDING_REFRESH_INTERVAL_MS = 24 * 60 * 60_000; // 1 day
/** Same idea for `last_used_at`. */
const TOUCH_INTERVAL_MS = 5 * 60_000; // 5 minutes

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly status: number,
    readonly field?: 'username' | 'password',
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthContext {
  readonly ip: string;
  readonly userAgent: string | null;
  /** Injected so tests control time and never sleep. */
  readonly now: number;
}

export interface IssuedSession {
  /** The plaintext token. Returned once, set as a cookie, never stored. */
  readonly token: string;
  readonly expiresAt: number;
  readonly remember: boolean;
}

export interface AuthResult {
  readonly account: AccountSummary;
  readonly session: IssuedSession;
}

export interface ResolvedSession {
  readonly account: AccountSummary;
  readonly expiresAt: number;
  readonly remember: boolean;
}

function toSummary(row: AccountRow): AccountSummary {
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

export class AuthService {
  private readonly byUsername = new RateLimiter(USERNAME_LIMITS);
  private readonly byIp = new RateLimiter(IP_LIMITS);

  constructor(private readonly repos: Repositories) {}

  /** Account creation. Username and password only — nothing else is collected. */
  async signup(
    username: string,
    password: string,
    remember: boolean,
    ctx: AuthContext,
  ): Promise<AuthResult> {
    this.assertNotRateLimited(`ip:${ctx.ip}`, this.byIp, ctx.now);

    const name = normalizeUsername(username);

    const usernameProblem = validateUsername(name);
    if (usernameProblem !== null) {
      throw new AuthError('validation_failed', describeProblem(usernameProblem), 400, 'username');
    }

    const passwordProblem = validatePassword(password);
    if (passwordProblem !== null) {
      throw new AuthError('validation_failed', describeProblem(passwordProblem), 400, 'password');
    }

    if (isCommonPassword(password)) {
      throw new AuthError(
        'password_too_common',
        'That password is too common. Choose something less guessable.',
        400,
        'password',
      );
    }

    const key = usernameKey(name);
    if (await this.repos.accounts.usernameExists(key)) {
      throw new AuthError('username_taken', 'That username is already taken.', 409, 'username');
    }

    const id = newAccountId();
    const passwordHash = await hashPassword(password);

    try {
      await this.repos.accounts.create({
        id,
        username: name,
        usernameLower: key,
        passwordHash,
        now: ctx.now,
      });
    } catch (err) {
      // The UNIQUE index is the real arbiter — two simultaneous signups can both pass the
      // existence check above. Translate the constraint violation rather than 500ing.
      if (isUniqueViolation(err)) {
        throw new AuthError('username_taken', 'That username is already taken.', 409, 'username');
      }
      throw err;
    }

    const account = await this.repos.accounts.findById(id);
    if (account === undefined) throw new AuthError('internal_error', 'Account vanished.', 500);

    const session = await this.issueSession(id, remember, ctx);
    return { account: toSummary(account), session };
  }

  async login(
    username: string,
    password: string,
    remember: boolean,
    ctx: AuthContext,
  ): Promise<AuthResult> {
    const name = normalizeUsername(username);
    const key = usernameKey(name);

    this.assertNotRateLimited(`ip:${ctx.ip}`, this.byIp, ctx.now);
    this.assertNotRateLimited(`user:${key}`, this.byUsername, ctx.now);

    // Bound the work before doing any: an unbounded password is unbounded argon2 CPU.
    if (validatePassword(password) === 'password_too_long') {
      throw this.invalidCredentials(key, ctx);
    }

    const account = await this.repos.accounts.findByUsernameKey(key);

    // Always runs argon2, even when there is no such account, so response time does not
    // reveal whether the username exists.
    const ok = await verifyPassword(account?.password_hash, password);
    if (!ok || account === undefined) {
      throw this.invalidCredentials(key, ctx);
    }

    this.byUsername.clear(`user:${key}`);
    this.byIp.clear(`ip:${ctx.ip}`);

    await this.repos.accounts.touchLastSeen(account.id, ctx.now);
    const session = await this.issueSession(account.id, remember, ctx);
    return { account: toSummary(account), session };
  }

  /** Resolves a session cookie to an account, sliding the expiry for remembered sessions. */
  async resolveSession(token: string, now: number): Promise<ResolvedSession | undefined> {
    const tokenHash = hashSessionToken(token);
    const session = await this.repos.sessions.findByTokenHash(tokenHash);
    if (session === undefined) return undefined;

    if (session.expires_at <= now) {
      await this.repos.sessions.deleteByTokenHash(tokenHash);
      return undefined;
    }

    const account = await this.repos.accounts.findById(session.account_id);
    if (account === undefined) {
      // The account was deleted while a session was live.
      await this.repos.sessions.deleteByTokenHash(tokenHash);
      return undefined;
    }

    const remember = session.remember === 1;
    let expiresAt = session.expires_at;

    const shouldSlide = remember && now - session.last_used_at > SLIDING_REFRESH_INTERVAL_MS;
    const shouldTouch = now - session.last_used_at > TOUCH_INTERVAL_MS;

    if (shouldSlide) expiresAt = now + REMEMBER_TTL_MS;
    if (shouldSlide || shouldTouch) {
      await this.repos.sessions.touch(tokenHash, now, expiresAt);
    }

    return { account: toSummary(account), expiresAt, remember };
  }

  async logout(token: string): Promise<number> {
    return this.repos.sessions.deleteByTokenHash(hashSessionToken(token));
  }

  async logoutAll(accountId: string): Promise<number> {
    return this.repos.sessions.deleteAllForAccount(accountId);
  }

  /** Housekeeping: drop expired rows and stale limiter entries. */
  async sweep(now: number): Promise<number> {
    this.byUsername.sweep(now);
    this.byIp.sweep(now);
    return this.repos.sessions.deleteExpired(now);
  }

  private async issueSession(
    accountId: string,
    remember: boolean,
    ctx: AuthContext,
  ): Promise<IssuedSession> {
    const token = generateSessionToken();
    const expiresAt = ctx.now + (remember ? REMEMBER_TTL_MS : SESSION_TTL_MS);

    await this.repos.sessions.create({
      tokenHash: hashSessionToken(token),
      accountId,
      now: ctx.now,
      expiresAt,
      remember,
      userAgent: ctx.userAgent,
    });

    return { token, expiresAt, remember };
  }

  private invalidCredentials(usernameKeyValue: string, ctx: AuthContext): AuthError {
    this.byUsername.recordFailure(`user:${usernameKeyValue}`, ctx.now);
    this.byIp.recordFailure(`ip:${ctx.ip}`, ctx.now);
    // One message for both "no such user" and "wrong password" — never confirm which.
    return new AuthError('invalid_credentials', 'Incorrect username or password.', 401);
  }

  private assertNotRateLimited(key: string, limiter: RateLimiter, now: number): void {
    const decision = limiter.check(key, now);
    if (!decision.allowed) {
      throw new AuthError(
        'rate_limited',
        'Too many attempts. Try again later.',
        429,
        undefined,
        decision.retryAfterSeconds,
      );
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  // SQLITE_CONSTRAINT_UNIQUE / SQLITE_CONSTRAINT_PRIMARYKEY, and Postgres 23505.
  return (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    code === '23505'
  );
}
