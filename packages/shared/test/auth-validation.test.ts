import { describe, expect, it } from 'vitest';

import {
  describeProblem,
  normalizeUsername,
  PASSWORD_MIN_LENGTH,
  usernameKey,
  validatePassword,
  validateUsername,
} from '../src/index.js';

describe('validateUsername', () => {
  it('accepts the allowed character set', () => {
    for (const name of ['abc', 'Player_1', 'a-b-c', 'ABC123', 'x'.repeat(20)]) {
      expect(validateUsername(name), name).toBeNull();
    }
  });

  it('rejects lengths outside 3–20', () => {
    expect(validateUsername('ab')).toBe('username_too_short');
    expect(validateUsername('x'.repeat(21))).toBe('username_too_long');
  });

  it('rejects characters outside [A-Za-z0-9_-]', () => {
    for (const name of ['has space', 'emoji😀x', 'semi;colon', 'quote"x', 'dot.dot']) {
      expect(validateUsername(name), name).toBe('username_invalid_characters');
    }
  });

  it('measures length after trimming', () => {
    expect(validateUsername('  ab  ')).toBe('username_too_short');
    expect(validateUsername('  abc  ')).toBeNull();
  });
});

describe('validatePassword', () => {
  it('accepts anything at least the minimum length, with no composition rules', () => {
    expect(validatePassword('a'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(validatePassword('all lowercase words no digits')).toBeNull();
    expect(validatePassword('   leading and trailing   ')).toBeNull();
  });

  it('rejects short passwords', () => {
    expect(validatePassword('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe('password_too_short');
  });

  it('bounds length so argon2 cannot be used as a CPU sink', () => {
    expect(validatePassword('a'.repeat(201))).toBe('password_too_long');
  });

  it('counts code points, not UTF-16 units', () => {
    // 10 emoji is 20 UTF-16 units but 10 characters, and should be allowed.
    expect(validatePassword('😀'.repeat(10))).toBeNull();
    expect(validatePassword('😀'.repeat(9))).toBe('password_too_short');
  });
});

describe('usernameKey', () => {
  it('folds case and trims, so uniqueness is case-insensitive', () => {
    expect(usernameKey('  PlayerOne ')).toBe('playerone');
    expect(usernameKey('PLAYERONE')).toBe(usernameKey('playerone'));
  });

  it('preserves the chosen case separately', () => {
    expect(normalizeUsername('  PlayerOne ')).toBe('PlayerOne');
  });
});

describe('describeProblem', () => {
  it('produces a message for every problem code', () => {
    const problems = [
      'username_too_short',
      'username_too_long',
      'username_invalid_characters',
      'password_too_short',
      'password_too_long',
    ] as const;

    for (const problem of problems) {
      expect(describeProblem(problem).length, problem).toBeGreaterThan(0);
    }
  });
});
