/**
 * @seg/shared/protocol/chat — the chat messages.
 *
 * On `control`, permanently, for the same reason lobby traffic is (planning/02 §3.1): a few
 * messages a minute at human speed, where a dropped one is a player staring at a screen that
 * did not change. There is nothing to gain from a data channel and a real cost to losing one.
 *
 * The server re-broadcasts rather than relaying: what goes out is a `ChatEntry` it built,
 * stamped with the sender's identity from the connection and the time from its own clock. A
 * client that could name its own author or its own timestamp could impersonate anyone.
 */

import type { ChatEntry, ChatProblem, ChatScope } from '../match/chat.js';
import type { Envelope } from './schema.js';

// ── client → server ─────────────────────────────────────────────────────────────────

export interface ChatSendMessage extends Envelope {
  readonly t: 'chat.send';
  readonly scope: ChatScope;
  readonly text: string;
}

export type ChatClientMessage = ChatSendMessage;

// ── server → client ─────────────────────────────────────────────────────────────────

/** One line, sent to every member of the match who can hear it (`canHear`). */
export interface ChatMessage extends Envelope {
  readonly t: 'chat.message';
  readonly entry: ChatEntry;
}

/**
 * That line did not go out, and here is why.
 *
 * Addressed to the sender alone. Separate from the fatal `error` message for the same reason
 * `lobby.rejected` is: being told to slow down is an ordinary answer to an ordinary request.
 */
export interface ChatRejectedMessage extends Envelope {
  readonly t: 'chat.rejected';
  readonly problem: ChatProblem;
  readonly message: string;
}

export type ChatServerMessage = ChatMessage | ChatRejectedMessage;

// ── helpers ─────────────────────────────────────────────────────────────────────────

export function createChatSend(scope: ChatScope, text: string): ChatSendMessage {
  return { t: 'chat.send', scope, text };
}

export function createChatMessage(entry: ChatEntry): ChatMessage {
  return { t: 'chat.message', entry };
}

export function createChatRejected(problem: ChatProblem, message: string): ChatRejectedMessage {
  return { t: 'chat.rejected', problem, message };
}
