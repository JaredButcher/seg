import {
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  describeJoinCodeProblem,
  normalizeJoinCode,
  validateJoinCode,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

describe('the join code alphabet', () => {
  it('contains no vowels, so a generated code cannot spell a word', () => {
    expect(JOIN_CODE_ALPHABET).not.toMatch(/[AEIOU]/);
  });

  it('excludes both members of every lookalike pair', () => {
    // Not "one of each pair" — both. A player who cannot tell 0 from O must not have to,
    // which is what lets normalizeJoinCode() skip lookalike folding entirely.
    for (const lookalike of ['0', 'O', '1', 'I', 'L', '5', 'S']) {
      expect(JOIN_CODE_ALPHABET).not.toContain(lookalike);
    }
  });

  it('has no repeated symbols', () => {
    expect(new Set(JOIN_CODE_ALPHABET).size).toBe(JOIN_CODE_ALPHABET.length);
  });
});

describe('normalizeJoinCode', () => {
  it('upper-cases, because players type in lowercase', () => {
    expect(normalizeJoinCode('bcdfgh')).toBe('BCDFGH');
  });

  it('strips the separators a code picks up when it is pasted out of chat', () => {
    expect(normalizeJoinCode('BCD-FGH')).toBe('BCDFGH');
    expect(normalizeJoinCode('  BCD FGH  ')).toBe('BCDFGH');
    expect(normalizeJoinCode('b c d - f g h')).toBe('BCDFGH');
  });

  it('is idempotent', () => {
    const once = normalizeJoinCode(' bcd-fgh ');
    expect(normalizeJoinCode(once)).toBe(once);
  });
});

describe('validateJoinCode', () => {
  it('accepts a well-formed code', () => {
    expect(validateJoinCode('BCDFGH')).toBeNull();
    expect(validateJoinCode('2346789'.slice(0, JOIN_CODE_LENGTH))).toBeNull();
  });

  it('accepts every symbol in the alphabet', () => {
    for (const symbol of JOIN_CODE_ALPHABET) {
      expect(validateJoinCode(symbol.repeat(JOIN_CODE_LENGTH))).toBeNull();
    }
  });

  it('distinguishes empty from wrong-length, because the messages differ', () => {
    expect(validateJoinCode('')).toBe('join_code_empty');
    expect(validateJoinCode('BCDFG')).toBe('join_code_wrong_length');
    expect(validateJoinCode('BCDFGHJ')).toBe('join_code_wrong_length');
  });

  it('rejects vowels and lookalike characters at the right length', () => {
    for (const bad of ['BCDFGA', 'BCDFG0', 'BCDFGO', 'BCDFG1', 'BCDFGL', 'BCDFGS']) {
      expect(validateJoinCode(bad)).toBe('join_code_invalid_characters');
    }
  });

  it('rejects lowercase — validation runs on the normalized form, not raw input', () => {
    expect(validateJoinCode('bcdfgh')).toBe('join_code_invalid_characters');
    expect(validateJoinCode(normalizeJoinCode('bcdfgh'))).toBeNull();
  });

  it('reports the separators as a length problem once they are stripped', () => {
    // "BCD-FGH" is 7 raw characters but a valid 6-character code.
    expect(validateJoinCode('BCD-FGH')).toBe('join_code_wrong_length');
    expect(validateJoinCode(normalizeJoinCode('BCD-FGH'))).toBeNull();
  });
});

describe('describeJoinCodeProblem', () => {
  it('has non-empty text for every problem', () => {
    const problems = [
      'join_code_empty',
      'join_code_wrong_length',
      'join_code_invalid_characters',
    ] as const;
    for (const problem of problems) {
      expect(describeJoinCodeProblem(problem).length).toBeGreaterThan(0);
    }
  });

  it('states the actual length rather than hardcoding a number', () => {
    expect(describeJoinCodeProblem('join_code_wrong_length')).toContain(String(JOIN_CODE_LENGTH));
  });
});
