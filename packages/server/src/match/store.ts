/**
 * @seg/server/match/store — the in-memory record of running matches.
 *
 * Like lobbies, matches are **not persisted** — a server restart ends them (planning/07 §4).
 * What lives here is the authoritative `MatchState`: both teams' boats, both scores, the
 * clock. It is the object a simulation tick would advance and the object every outbound view
 * frame is projected from.
 *
 * It is deliberately a dumb registry. It holds state and answers questions about it; it has no
 * rules of its own and it does not decide when a match ends. Those belong to the match runtime
 * that this store will outlive.
 *
 * **Nothing here is a wire shape.** Every accessor that produces one goes through
 * `setupFor`/`viewFor`, which is what keeps "the server knows everything" and "a player is
 * told what they have earned" from being the same code path (planning/01 §5).
 */

import {
  canHear,
  setupFor,
  viewFor,
  type AccountId,
  type ChatEntry,
  type MatchId,
  type MatchSetup,
  type MatchState,
  type MatchViewState,
} from '@seg/shared';

/** How many chat lines a match keeps, so a reconnecting player has context. */
const CHAT_BACKLOG = 50;

interface MatchRecord {
  state: MatchState;
  /** Monotonic per match, so a `ChatEntry` id is unique wherever it is rendered. */
  nextChatId: number;
  chat: ChatEntry[];
  /** Monotonic per recipient. A view sequence is per connection (planning/02 §3.4). */
  readonly viewSeq: Map<AccountId, number>;
}

export class MatchStore {
  private readonly matches = new Map<MatchId, MatchRecord>();

  /** Remember a match that has begun. */
  store(state: MatchState): void {
    this.matches.set(state.matchId, {
      state,
      nextChatId: 1,
      chat: [],
      viewSeq: new Map(),
    });
  }

  /** The ground truth of a running match. `undefined` when it is not found. */
  find(matchId: MatchId): MatchState | undefined {
    return this.matches.get(matchId)?.state;
  }

  /** Replace a match's state — what a tick will do, once there is one. */
  update(state: MatchState): void {
    const record = this.matches.get(state.matchId);
    if (record === undefined) return;
    record.state = state;
  }

  /**
   * The match an account is playing or watching, if any.
   *
   * A linear scan over a handful of live matches. It is called on connect and on chat, not
   * per tick, and an index would be a second thing to keep correct when a player leaves.
   */
  findByAccount(accountId: AccountId): MatchState | undefined {
    for (const record of this.matches.values()) {
      if (record.state.players.some((player) => player.accountId === accountId)) {
        return record.state;
      }
    }
    return undefined;
  }

  /** The static half of a match, addressed to one account. */
  setupFor(matchId: MatchId, accountId: AccountId): MatchSetup | undefined {
    const state = this.find(matchId);
    return state === undefined ? undefined : setupFor(state, accountId);
  }

  /** The volatile half, addressed to one account, with that connection's next sequence. */
  viewFor(
    matchId: MatchId,
    accountId: AccountId,
  ): { readonly seq: number; readonly view: MatchViewState } | undefined {
    const record = this.matches.get(matchId);
    if (record === undefined) return undefined;
    const seq = (record.viewSeq.get(accountId) ?? 0) + 1;
    record.viewSeq.set(accountId, seq);
    return { seq, view: viewFor(record.state, accountId) };
  }

  /** Mark a player connected or not. Their boats keep their orders either way (04 §5). */
  setConnected(accountId: AccountId, connected: boolean): void {
    for (const record of this.matches.values()) {
      const index = record.state.players.findIndex((p) => p.accountId === accountId);
      if (index === -1) continue;
      const players = record.state.players.map((player) =>
        player.accountId === accountId ? { ...player, connected } : player,
      );
      record.state = { ...record.state, players };
    }
  }

  // ── Chat ──────────────────────────────────────────────────────────────────────

  /**
   * Record a line and hand back the entry to broadcast.
   *
   * The id and the timestamp are minted here rather than accepted from the sender, which is
   * what stops a client naming its own place in the order.
   */
  addChat(matchId: MatchId, entry: Omit<ChatEntry, 'id'>): ChatEntry | undefined {
    const record = this.matches.get(matchId);
    if (record === undefined) return undefined;

    const full: ChatEntry = { ...entry, id: record.nextChatId++ };
    record.chat.push(full);
    if (record.chat.length > CHAT_BACKLOG) record.chat.splice(0, record.chat.length - CHAT_BACKLOG);
    return full;
  }

  /** The recent lines this account is allowed to read — the reconnect backlog. */
  chatFor(matchId: MatchId, accountId: AccountId): readonly ChatEntry[] {
    const record = this.matches.get(matchId);
    if (record === undefined) return [];
    const team = record.state.players.find((p) => p.accountId === accountId)?.team ?? null;
    return record.chat.filter((entry) => canHear(entry, team));
  }

  /** Drop a match that has ended. */
  remove(matchId: MatchId): void {
    this.matches.delete(matchId);
  }
}
