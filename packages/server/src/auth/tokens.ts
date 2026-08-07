import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** 256 bits of entropy, URL-safe. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 is the right choice here, not argon2. A password is low-entropy and needs a slow
 * hash to resist offline guessing; a 256-bit random token has nothing to guess, so the only
 * requirement is that a database leak does not yield usable tokens. A fast hash also keeps
 * session lookup off the critical path of every request.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newAccountId(): string {
  return randomUUID();
}
