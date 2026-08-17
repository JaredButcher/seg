/**
 * @seg/server/match/store — the main thread's record of running matches.
 *
 * Like lobbies, matches are **not persisted** — a server restart ends them (planning/07 §4).
 *
 * What changed when matches moved onto worker threads is what "the record" means. This file used
 * to hold the authoritative `MatchState` and the `MatchRuntime` advancing it; it now holds a
 * `MatchHost` per match and, on this side of the boundary, only the facts the main thread routes
 * and answers on:
 *
 * - **the digest** — who is seated, on which side, still connected, and the map bounds a command is
 *   checked against (`worker/protocol.ts`). Pushed by the worker when it changes, which is three
 *   or four times in a half-hour match.
 * - **the chat log**, which never touches the simulation and would only have made the boundary
 *   busier for nothing.
 * - **the results**, once a match has announced them, because "this match is finished" is what the
 *   reconnect path answers on.
 * - **the account index**, the single source of truth for routing a command.
 *
 * Everything else — boats, torpedoes, the chart, both teams' pictures, the view sequences — is on
 * the far side and stays there. There is no mirror, deliberately: a `MatchState` copied back every
 * publish would cost more than the threading saved and would put the enemy fleet on the thread
 * that has sockets attached to it (planning/01 §5).
 *
 * It is still a dumb registry with no rules of its own. It does not decide when a match ends; it is
 * *told*, by the thread that does.
 */

import type {
  AccountId,
  ChatEntry,
  CodecId,
  EntityId,
  MatchId,
  MatchResults,
  MatchState,
  ProbeReading,
  Vec2,
} from '@seg/shared';
import { canHear } from '@seg/shared';

import type { ConnectionRegistry } from '../realtime/connections.js';
import type { MatchHost } from './worker/host.js';
import type { MatchCommand, MatchDigest } from './worker/protocol.js';
import type { MatchPool } from './worker/pool.js';

/** How many chat lines a match keeps, so a reconnecting player has context. */
const CHAT_BACKLOG = 50;

interface MatchRecord {
  /** The thread this match runs on, and the only way to reach its state. */
  readonly host: MatchHost;
  /** What the main thread is allowed to know, as of the worker's last push. */
  digest: MatchDigest;
  /**
   * The results, once announced, or `null` while the match is being played.
   *
   * The main thread's copy of a fact the worker owns. Kept because it is what "this match is
   * finished" means to everything up here: a player who reconnects afterwards is handed this
   * instead of a live HUD, and nothing is going to ask the thread again to find out.
   */
  results: MatchResults | null;
  /**
   * The lobby this match began from, captured once at start.
   *
   * Not read off `LobbyService` later — a disconnect (or a deliberate leave) can evict the
   * account from lobby membership, and losing the last member can delete the lobby record
   * outright, while the match it started keeps running. This is the only durable copy of the
   * name a rejoin button needs.
   */
  readonly lobbyName: string;
  /** Monotonic per match, so a `ChatEntry` id is unique wherever it is rendered. */
  nextChatId: number;
  chat: ChatEntry[];
}

export interface MatchStoreOptions {
  readonly pool: MatchPool;
  /** Where a worker's finished bytes go. */
  readonly connections: ConnectionRegistry;
}

/** Told when a match ends — either because it decided itself, or because its thread died. */
export type ConcludeListener = (matchId: MatchId, results: MatchResults) => void;

/**
 * Told when a match's thread was lost with no results to show for it.
 *
 * The genuinely new failure mode (`worker/host.ts`). There is nothing to salvage — the only copy of
 * the state was in that isolate — so the honest thing is to tell the players the match is gone.
 */
export type LostListener = (matchId: MatchId, reason: string) => void;

export class MatchStore {
  private readonly matches = new Map<MatchId, MatchRecord>();
  /**
   * Which match each account is seated in, if any — the single source of truth for routing a
   * command and for answering "is there anything to rejoin". Not derived by scanning
   * `matches`: an account's membership is a fact about the account, set exactly where it
   * becomes true (`begin`) and cleared exactly where it stops being true (`release`), so there
   * is never a second match for a stale entry to shadow the real one behind.
   */
  private readonly byAccount = new Map<AccountId, MatchId>();
  private readonly pool: MatchPool;
  private readonly connections: ConnectionRegistry;
  private readonly concluded: ConcludeListener[] = [];
  private readonly lost: LostListener[] = [];

  constructor(options: MatchStoreOptions) {
    this.pool = options.pool;
    this.connections = options.connections;
  }

  /**
   * Subscribe to match endings.
   *
   * A listener rather than a constructor callback because the thing that wants to know is
   * `MatchHandler`, and the handler is built *after* the store it reads from (`app.ts`). The
   * alternative is a mutable field nobody can see being set.
   */
  onConcluded(listener: ConcludeListener): void {
    this.concluded.push(listener);
  }

  onLost(listener: LostListener): void {
    this.lost.push(listener);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────────

  /**
   * Put a deployed match on a thread.
   *
   * `false` means the server is at its concurrency cap and the match did not start — a normal
   * operating condition rather than an error, reported so `lobby.start` can say so and leave the
   * lobby standing (`worker/pool.ts`). A worker that fails to *boot* throws instead, because that
   * is a broken deployment rather than a busy one.
   */
  async begin(state: MatchState, lobbyName: string): Promise<boolean> {
    const matchId = state.matchId;
    const host = await this.pool.acquire(state, {
      onOutbound: (bundles) => {
        for (const bundle of bundles) this.connections.deliver(bundle.accountId, bundle.payloads);
      },
      onResults: (results) => {
        this.settle(matchId, results);
      },
      onDigest: (digest) => {
        const record = this.matches.get(matchId);
        if (record !== undefined) record.digest = digest;
      },
      onLost: (reason) => {
        this.abandonThread(matchId, reason);
      },
      onTickError: (message) => {
        console.error('[seg] match tick failed', matchId, message);
      },
    });
    if (host === null) return false;

    this.matches.set(matchId, {
      host,
      digest: host.digest,
      results: null,
      lobbyName,
      nextChatId: 1,
      chat: [],
    });
    for (const player of state.players) this.byAccount.set(player.accountId, matchId);
    return true;
  }

  /** Record results and announce them once. Called by the worker's own decision, never polled. */
  private settle(matchId: MatchId, results: MatchResults): void {
    const record = this.matches.get(matchId);
    if (record === undefined || record.results !== null) return;
    record.results = results;
    for (const listener of this.concluded) listener(matchId, results);
  }

  private abandonThread(matchId: MatchId, reason: string): void {
    console.error('[seg] match thread lost', matchId, reason);
    const record = this.matches.get(matchId);
    if (record === undefined) return;
    for (const listener of this.lost) listener(matchId, reason);
    // The slot goes back whether or not anybody handled it: a dead thread that keeps its place
    // against the cap is a match nobody can start for the life of the process.
    void this.remove(matchId);
  }

  /** Drop a match and free its thread. */
  async remove(matchId: MatchId): Promise<void> {
    this.matches.delete(matchId);
    await this.pool.remove(matchId);
  }

  /** End every match. The shutdown path. */
  async close(): Promise<void> {
    this.matches.clear();
    this.byAccount.clear();
    await this.pool.close();
  }

  // ── What the main thread knows ────────────────────────────────────────────────────

  /** What the main thread is allowed to know about a match. `undefined` when it is not found. */
  digest(matchId: MatchId): MatchDigest | undefined {
    return this.matches.get(matchId)?.digest;
  }

  /** The match an account is playing or watching, if any — via the account index. */
  digestByAccount(accountId: AccountId): MatchDigest | undefined {
    const matchId = this.byAccount.get(accountId);
    if (matchId === undefined) return undefined;
    return this.matches.get(matchId)?.digest;
  }

  /** How a match ended, for a player arriving after it did. `undefined` while it is still on. */
  resultsFor(matchId: MatchId): MatchResults | undefined {
    return this.matches.get(matchId)?.results ?? undefined;
  }

  /** The lobby a match began from, for a rejoin button. `undefined` for an unknown match. */
  lobbyNameFor(matchId: MatchId): string | undefined {
    return this.matches.get(matchId)?.lobbyName;
  }

  /** Whether a start would be refused right now, and how many threads are in use. */
  get capacity(): { readonly running: number; readonly limit: number } {
    return { running: this.pool.size, limit: this.pool.limit };
  }

  /**
   * The account has committed to a different lobby (`lobby.create`/`lobby.join`): whatever
   * match it used to be seated in stops being theirs to rejoin or to route a command to.
   *
   * Deliberately does not touch the match itself — the boats are unaffected; only this account's
   * *claim* on it is. A boat an abandoned account owned keeps coasting on its last standing order
   * exactly as a merely-disconnected one does.
   */
  release(accountId: AccountId): void {
    this.byAccount.delete(accountId);
  }

  // ── Reaching the thread ───────────────────────────────────────────────────────────

  private hostFor(accountId: AccountId): MatchHost | undefined {
    const matchId = this.byAccount.get(accountId);
    if (matchId === undefined) return undefined;
    return this.matches.get(matchId)?.host;
  }

  /**
   * Apply a command to whichever match this account is seated in.
   *
   * Returns nothing, and that is not a simplification made for the boundary's sake — every one of
   * these already discarded its result before threads existed. The receipt for a shot is the tube
   * going into reload on the next view frame (`match/handler.ts`), so there was never an answer
   * for a caller to wait on.
   */
  command(accountId: AccountId, cmd: MatchCommand): void {
    this.hostFor(accountId)?.command(accountId, cmd);
  }

  /**
   * The one question in the match protocol (`debug.probe`).
   *
   * `undefined` for an account in no match; a `null` reading for a point or a moment that cannot
   * be measured. The panel treats both the same way — it keeps the last reading it had.
   */
  async probe(
    accountId: AccountId,
    boat: EntityId | null,
    at: Vec2,
  ): Promise<{ reading: ProbeReading | null; tick: number } | undefined> {
    const host = this.hostFor(accountId);
    if (host === undefined) return undefined;
    return host.probe(boat, at);
  }

  /**
   * Mark a player connected or not. Their boats keep their orders either way (planning/04 §5).
   *
   * `codec` is `null` on a departure, where there is no socket to have negotiated one.
   */
  setConnected(accountId: AccountId, connected: boolean, codec: CodecId | null): void {
    this.hostFor(accountId)?.presence(accountId, connected, codec);
  }

  /**
   * Start this account's chart from nothing again.
   *
   * A reconnecting player's client is a fresh tab with no chart in it, so the watermark has to
   * go back to zero or they would be owed only what their team confirmed while they were away.
   */
  resetVision(accountId: AccountId): void {
    this.hostFor(accountId)?.forget(accountId);
  }

  /** Have the match send this account its setup and a fresh view frame. */
  resend(accountId: AccountId): void {
    this.hostFor(accountId)?.resend(accountId);
  }

  /** Advance a match by one tick by hand. Only meaningful for a pool built unscheduled. */
  step(matchId: MatchId): void {
    this.matches.get(matchId)?.host.step();
  }

  /**
   * Resolve once a match's thread has handled everything posted before this call.
   *
   * A test's tool (`worker/protocol.ts#sync`). Resolves immediately for a match that is not here,
   * which is what a teardown wants.
   */
  async sync(matchId: MatchId): Promise<void> {
    await this.matches.get(matchId)?.host.sync();
  }

  // ── Chat ──────────────────────────────────────────────────────────────────────────

  /**
   * Record a line and hand back the entry to broadcast.
   *
   * Stays on this thread, and is the one part of a match that does. Nothing in the simulation
   * reads it, so sending it across the boundary and back would buy a busier boundary and no
   * separation at all — and the ids minted here would then have to come back to be minted.
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
    const team = record.digest.players.find((p) => p.accountId === accountId)?.team ?? null;
    return record.chat.filter((entry) => canHear(entry, team));
  }
}
