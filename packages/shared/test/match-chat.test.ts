/**
 * Chat rules: what may be said, on which channel, and who hears it.
 *
 * The normalizer is the interesting half. Chat is the one string in the game that is not
 * restricted to printable ASCII — an ASCII-only chat box is unusable for most of the world —
 * so it has to remove exactly the characters that attack the renderer while leaving every
 * language intact.
 */

import {
  canHear,
  canSpeakOn,
  CHAT_MAX_LENGTH,
  describeChatProblem,
  isChatScope,
  normalizeChatText,
  validateChatText,
  type ChatEntry,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

function entry(overrides: Partial<ChatEntry> = {}): ChatEntry {
  return {
    id: 1,
    from: 'a1',
    username: 'Skipper',
    team: 'team1',
    scope: 'team',
    text: 'contact west',
    at: 0,
    ...overrides,
  };
}

describe('normalizing', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeChatText('  going   deep  ')).toBe('going deep');
    expect(normalizeChatText('two\nlines')).toBe('two lines');
  });

  it('leaves ordinary text in any language alone', () => {
    expect(normalizeChatText('sous-marin à 400 m')).toBe('sous-marin à 400 m');
    expect(normalizeChatText('潜水艦が見える')).toBe('潜水艦が見える');
    expect(normalizeChatText('غواصة')).toBe('غواصة');
  });

  it('strips the characters that rearrange the text around them', () => {
    // Bidi overrides let a string reverse the rendering of the line it sits in, which in a
    // chat log means impersonating another player's name. They come out as a space, so the
    // words either side stay separate — the same rule that keeps a newline from gluing two
    // lines into one word.
    const attack = `Skipper${String.fromCharCode(0x202e)}nice shot`;
    expect(normalizeChatText(attack)).toBe('Skipper nice shot');
    expect(normalizeChatText(`a${String.fromCharCode(0)}b`)).toBe('a b');
    expect(normalizeChatText(`a${String.fromCharCode(0x2066)}b`)).toBe('a b');
  });
});

describe('validating', () => {
  it('refuses an empty line and an oversized one', () => {
    expect(validateChatText('')).toBe('empty');
    expect(validateChatText(normalizeChatText('   '))).toBe('empty');
    expect(validateChatText('x'.repeat(CHAT_MAX_LENGTH))).toBeNull();
    expect(validateChatText('x'.repeat(CHAT_MAX_LENGTH + 1))).toBe('too_long');
  });

  it('has something to say about every problem it can report', () => {
    for (const problem of ['empty', 'too_long', 'wrong_scope', 'rate_limited'] as const) {
      expect(describeChatProblem(problem).length).toBeGreaterThan(0);
    }
    expect(isChatScope('team')).toBe(true);
    expect(isChatScope('shout')).toBe(false);
  });
});

describe('who may speak', () => {
  it('holds spectators to their own channel, and players out of it', () => {
    expect(canSpeakOn('team', 'team1')).toBe(true);
    expect(canSpeakOn('all', 'team1')).toBe(true);
    expect(canSpeakOn('spectator', 'team1')).toBe(false);

    expect(canSpeakOn('spectator', null)).toBe(true);
    expect(canSpeakOn('team', null)).toBe(false);
    expect(canSpeakOn('all', null)).toBe(false);
  });
});

describe('who hears it', () => {
  it('keeps a team line inside the team', () => {
    const line = entry({ scope: 'team', team: 'team1' });

    expect(canHear(line, 'team1')).toBe(true);
    expect(canHear(line, 'team2')).toBe(false);
  });

  it('lets an all line reach everyone', () => {
    const line = entry({ scope: 'all' });

    expect(canHear(line, 'team1')).toBe(true);
    expect(canHear(line, 'team2')).toBe(true);
    expect(canHear(line, null)).toBe(true);
  });

  it('keeps the observers’ channel to the observers', () => {
    const line = entry({ scope: 'spectator', team: null });

    expect(canHear(line, null)).toBe(true);
    expect(canHear(line, 'team1')).toBe(false);
  });

  it('lets a spectator read both teams, per planning/08 §11', () => {
    expect(canHear(entry({ scope: 'team', team: 'team1' }), null)).toBe(true);
    expect(canHear(entry({ scope: 'team', team: 'team2' }), null)).toBe(true);
  });
});
