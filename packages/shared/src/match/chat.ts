/**
 * @seg/shared/match/chat — in-match chat (planning/08 §11, element 6).
 *
 * Rules on both sides, as everywhere else: the client checks before it sends so a player is
 * told immediately, and the server checks because a message arriving over the wire is
 * untrusted. Neither is the other's backstop.
 *
 * Scope-bound **quick pings** — "contact at X,Y(D)", "go here", "listen here" — are the other
 * half of element 6 and are not here. They are chat entries *and* scope markers, and the
 * marker half needs the selection and world-click plumbing the command interface brings
 * (planning/08 §5). Free text first; the pings hang off the same messages when it lands.
 */

import type { AccountId } from '../lobby/state.js';
import type { TeamId } from './world.js';

/**
 * Who a line is addressed to.
 *
 * `spectator` is the observers' own channel. Spectators may read team and all chat but not
 * speak in either (planning/08 §11), so without a third scope they would have no voice at
 * all — and a room of silent observers invents its own out-of-band channel immediately.
 */
export const CHAT_SCOPES = ['team', 'all', 'spectator'] as const;
export type ChatScope = (typeof CHAT_SCOPES)[number];

export function isChatScope(value: unknown): value is ChatScope {
  return typeof value === 'string' && (CHAT_SCOPES as readonly string[]).includes(value);
}

/** Team chat is the default: it is the one that is useful mid-match (planning/08 §11). */
export const DEFAULT_CHAT_SCOPE: ChatScope = 'team';

/** planning/02 §7. Long enough for a real sentence, short enough not to be a payload. */
export const CHAT_MAX_LENGTH = 200;

/** planning/02 §7: three messages per five seconds. */
export const CHAT_BURST = 3;
export const CHAT_WINDOW_MS = 5_000;

/** How many lines a client keeps. The panel shows the last one collapsed (08 §11). */
export const CHAT_HISTORY_LIMIT = 100;

/** One line, as everyone who can hear it receives it. */
export interface ChatEntry {
  /** Unique within a match. Lets a client dedupe and key a list without a local counter. */
  readonly id: number;
  readonly from: AccountId;
  /** Denormalized so a client can render a line without a roster lookup that may have moved on. */
  readonly username: string;
  /** The sender's side when they spoke. `null` for a spectator. */
  readonly team: TeamId | null;
  readonly scope: ChatScope;
  readonly text: string;
  /** Epoch ms, stamped by the server. */
  readonly at: number;
}

export type ChatProblem = 'empty' | 'too_long' | 'wrong_scope' | 'rate_limited';

export function describeChatProblem(problem: ChatProblem): string {
  switch (problem) {
    case 'empty':
      return 'Say something first.';
    case 'too_long':
      return `Keep it under ${CHAT_MAX_LENGTH} characters.`;
    case 'wrong_scope':
      return 'You cannot speak on that channel.';
    case 'rate_limited':
      return 'Slow down.';
  }
}

/*
 * Control characters and the bidirectional overrides, stripped.
 *
 * Chat is the one place in the game where restricting the character set the way lobby and
 * fleet names are restricted (`fleet/validate.ts`) would be the wrong trade — an ASCII-only
 * chat box is unusable for most of the world. So the surface stays open and only the
 * characters that attack the *renderer* rather than the reader are removed: C0 and C1
 * controls, and the RTL/LTR overrides that let a string rearrange the text around it.
 */
/* eslint-disable no-control-regex -- matching control characters is the entire point here. */
const HOSTILE_CHARACTERS = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]',
  'gu',
);
/* eslint-enable no-control-regex */

/** Strips what must not be rendered, collapses runs of whitespace, and trims. */
export function normalizeChatText(text: string): string {
  // Replaced with a space rather than removed: a newline *is* a control character, and
  // deleting it outright glues the words either side of it together.
  return text.replace(HOSTILE_CHARACTERS, ' ').replace(/\s+/gu, ' ').trim();
}

/** Validates already-normalized text. */
export function validateChatText(text: string): ChatProblem | null {
  if (text.length === 0) return 'empty';
  if (text.length > CHAT_MAX_LENGTH) return 'too_long';
  return null;
}

/**
 * Whether a member of the match may speak on a channel.
 *
 * Spectators are held to their own channel. Everyone else is held out of it — an observers'
 * channel a player can post in is not one.
 */
export function canSpeakOn(scope: ChatScope, team: TeamId | null): boolean {
  return team === null ? scope === 'spectator' : scope !== 'spectator';
}

/**
 * Whether a member of the match hears a line.
 *
 * Spectators hear both teams, per planning/08 §11. That is a real intel channel if an
 * observer relays it, and it is written down here rather than buried: the lever if it proves
 * abusable is the spectator-vision lobby setting (07 §5), not a quiet change to this function.
 */
export function canHear(entry: ChatEntry, listenerTeam: TeamId | null): boolean {
  switch (entry.scope) {
    case 'all':
      return true;
    case 'spectator':
      return listenerTeam === null;
    case 'team':
      return listenerTeam === null || listenerTeam === entry.team;
  }
}
