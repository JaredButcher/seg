/**
 * Credential rules — the single source of truth for both sides.
 *
 * The client uses these to validate a form before submitting; the server uses the same
 * functions to enforce. Sharing them is the point: a rule that exists in two places is a
 * rule that will eventually disagree with itself.
 *
 * Rules come from planning/07 §2.
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export const PASSWORD_MIN_LENGTH = 10;
/**
 * Not a security rule — a denial-of-service bound. Argon2 hashes whatever it is given,
 * so an unbounded password is unbounded server CPU.
 */
export const PASSWORD_MAX_LENGTH = 200;

export type UsernameProblem =
  'username_too_short' | 'username_too_long' | 'username_invalid_characters';

export type PasswordProblem = 'password_too_short' | 'password_too_long';

/**
 * Usernames are compared case-insensitively but stored with the case the player chose.
 * This derives the comparison key; `account.username_lower` holds it.
 */
export function usernameKey(username: string): string {
  return username.trim().toLowerCase();
}

/** Trims surrounding whitespace. Passwords are never trimmed — leading spaces are legitimate. */
export function normalizeUsername(username: string): string {
  return username.trim();
}

export function validateUsername(username: string): UsernameProblem | null {
  const trimmed = normalizeUsername(username);
  if (trimmed.length < USERNAME_MIN_LENGTH) return 'username_too_short';
  if (trimmed.length > USERNAME_MAX_LENGTH) return 'username_too_long';
  if (!USERNAME_PATTERN.test(trimmed)) return 'username_invalid_characters';
  return null;
}

export function validatePassword(password: string): PasswordProblem | null {
  // Measured in code points, not UTF-16 units, so an emoji counts as one character.
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return 'password_too_short';
  if (length > PASSWORD_MAX_LENGTH) return 'password_too_long';
  return null;
}

/** Human-readable text for a validation problem. Shown by the client, sent by the server. */
export function describeProblem(problem: UsernameProblem | PasswordProblem): string {
  switch (problem) {
    case 'username_too_short':
      return `Username must be at least ${USERNAME_MIN_LENGTH} characters.`;
    case 'username_too_long':
      return `Username must be at most ${USERNAME_MAX_LENGTH} characters.`;
    case 'username_invalid_characters':
      return 'Username may contain only letters, numbers, hyphens, and underscores.';
    case 'password_too_short':
      return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
    case 'password_too_long':
      return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
}
