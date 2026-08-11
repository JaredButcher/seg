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
  teamFor,
  viewFor,
  type AccountId,
  type ChatEntry,
  type EntityId,
  type MatchId,
  type MatchResults,
  type MatchSetup,
  type MatchState,
  type MatchViewState,
  type Vec2,
  type WeaponId,
} from '@seg/shared';

import { MatchRuntime, type MatchRuntimeOptions } from './runtime.js';

/** How many chat lines a match keeps, so a reconnecting player has context. */
const CHAT_BACKLOG = 50;

interface MatchRecord {
  /**
   * The running match. The state lives inside it rather than beside it, because a second copy
   * is a second answer the first time a tick advances one of them.
   */
  readonly runtime: MatchRuntime;
  /**
   * The results, once they have been announced, or `null` while the match is being played.
   *
   * Kept here rather than read off the runtime each time because it is what "this match is
   * finished" *means* to everything above the simulation: the clock stops walking it, and a
   * player who reconnects afterwards is handed this instead of a live HUD.
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
  /** Monotonic per recipient. A view sequence is per connection (planning/02 §3.4). */
  readonly viewSeq: Map<AccountId, number>;
}

export class MatchStore {
  private readonly matches = new Map<MatchId, MatchRecord>();
  /**
   * Which match each account is seated in, if any — the single source of truth for routing a
   * command and for answering "is there anything to rejoin". Not derived by scanning
   * `matches`: an account's membership is a fact about the account, set exactly where it
   * becomes true (`store`) and cleared exactly where it stops being true (`release`), so there
   * is never a second match for a stale entry to shadow the real one behind.
   */
  private readonly byAccount = new Map<AccountId, MatchId>();

  constructor(private readonly runtimeOptions: MatchRuntimeOptions = {}) {}

  /** Remember a match that has begun, and build the runtime that will advance it. */
  store(state: MatchState, lobbyName: string): void {
    this.matches.set(state.matchId, {
      runtime: new MatchRuntime(state, this.runtimeOptions),
      results: null,
      lobbyName,
      nextChatId: 1,
      chat: [],
      viewSeq: new Map(),
    });
    for (const player of state.players) this.byAccount.set(player.accountId, state.matchId);
  }

  /** The ground truth of a running match. `undefined` when it is not found. */
  find(matchId: MatchId): MatchState | undefined {
    return this.matches.get(matchId)?.runtime.state;
  }

  /** The runtime driving a match, for whatever is ticking it. */
  runtime(matchId: MatchId): MatchRuntime | undefined {
    return this.matches.get(matchId)?.runtime;
  }

  /**
   * Every match still being played, for the clock that drives them all.
   *
   * A finished match is left in the map — a player who reconnects is owed its results — but it
   * is not handed out here. The runtime would refuse to advance it anyway (`MatchRuntime.tick`);
   * this is what stops the clock asking thirty times a second.
   */
  running(): readonly { readonly matchId: MatchId; readonly runtime: MatchRuntime }[] {
    return [...this.matches]
      .filter(([, record]) => record.results === null)
      .map(([matchId, record]) => ({ matchId, runtime: record.runtime }));
  }

  /**
   * Record that a match has ended, so it stops being ticked and its results can be re-sent.
   *
   * Returns them the first time and `undefined` on every call after, which is what makes
   * announcing the end exactly-once without the caller keeping a set of ids: the clock walks
   * every match and the one that just ended answers once.
   */
  conclude(matchId: MatchId): MatchResults | undefined {
    const record = this.matches.get(matchId);
    if (record === undefined || record.results !== null) return undefined;
    const results = record.runtime.results;
    if (results === null) return undefined;
    record.results = results;
    return results;
  }

  /** How a match ended, for a player arriving after it did. `undefined` while it is still on. */
  resultsFor(matchId: MatchId): MatchResults | undefined {
    return this.matches.get(matchId)?.results ?? undefined;
  }

  /** Replace a match's state. */
  update(state: MatchState): void {
    this.matches.get(state.matchId)?.runtime.replace(state);
  }

  /** The match an account is playing or watching, if any — via the account index. */
  findByAccount(accountId: AccountId): MatchState | undefined {
    const matchId = this.byAccount.get(accountId);
    if (matchId === undefined) return undefined;
    return this.matches.get(matchId)?.runtime.state;
  }

  /** The lobby a match began from, for a rejoin button. `undefined` for an unknown match. */
  lobbyNameFor(matchId: MatchId): string | undefined {
    return this.matches.get(matchId)?.lobbyName;
  }

  /**
   * The account has committed to a different lobby (`lobby.create`/`lobby.join`): whatever
   * match it used to be seated in stops being theirs to rejoin or to route a command to.
   *
   * Deliberately does not touch `MatchState.players` — the match itself, and the boats in it,
   * are unaffected; only this account's *claim* on it is. A boat an abandoned account owned
   * keeps coasting on its last standing order exactly as a merely-disconnected one does.
   */
  release(accountId: AccountId): void {
    this.byAccount.delete(accountId);
  }

  /** The static half of a match, addressed to one account. */
  setupFor(matchId: MatchId, accountId: AccountId): MatchSetup | undefined {
    const record = this.matches.get(matchId);
    if (record === undefined) return undefined;
    return setupFor(record.runtime.state, accountId, record.runtime.hasDebugVision(accountId));
  }

  /**
   * The volatile half, addressed to one account, with that connection's next sequence.
   *
   * **Not a pure read.** Building a frame advances two watermarks — the view sequence and the
   * recipient's place in their team's chart — so calling this twice for one tick would number
   * two frames differently and would hand the second one an empty chart slice. There is exactly
   * one caller per frame per recipient, and that is a rule rather than an accident.
   */
  viewFor(
    matchId: MatchId,
    accountId: AccountId,
  ): { readonly seq: number; readonly view: MatchViewState } | undefined {
    const record = this.matches.get(matchId);
    if (record === undefined) return undefined;

    const state = record.runtime.state;
    const seq = (record.viewSeq.get(accountId) ?? 0) + 1;
    record.viewSeq.set(accountId, seq);

    const vision = record.runtime.visionFor(accountId, teamFor(state, accountId));
    return {
      seq,
      view: viewFor(state, accountId, vision, record.runtime.hasDebugVision(accountId)),
    };
  }

  /**
   * Start this account's chart from nothing again.
   *
   * A reconnecting player's client is a fresh tab with no chart in it, so the watermark has to
   * go back to zero or they would be owed only what their team confirmed while they were away.
   */
  resetVision(accountId: AccountId): void {
    const matchId = this.byAccount.get(accountId);
    if (matchId === undefined) return;
    this.matches.get(matchId)?.runtime.forget(accountId);
  }

  /**
   * Switch one of an account's boats to active or passive sonar.
   *
   * Addressed by account rather than by match id, because a command arrives on a connection and
   * a connection knows who it is and nothing else. The runtime owns the ownership check.
   */
  setActiveSonar(accountId: AccountId, boat: EntityId, active: boolean): boolean {
    const matchId = this.byAccount.get(accountId);
    if (matchId === undefined) return false;
    return this.matches.get(matchId)?.runtime.setActiveSonar(accountId, boat, active) ?? false;
  }

  /**
   * Fire tubes on one of an account's boats. Returns how many weapons left.
   *
   * Addressed by account like `setActiveSonar`, and for the same reason: a command arrives on a
   * connection, and a connection knows who it is and nothing else. The runtime owns every rule —
   * ownership, whether the tube is loaded, whether the load is one that can be deployed.
   */
  fire(accountId: AccountId, boat: EntityId, tubes: readonly number[], to: Vec2): number {
    const matchId = this.byAccount.get(accountId);
    if (matchId === undefined) return 0;
    return this.matches.get(matchId)?.runtime.fire(accountId, boat, tubes, to) ?? 0;
  }

  /** Choose a tube's next load, or swap what it is holding. */
  load(
    accountId: AccountId,
    boat: EntityId,
    tube: number,
    weapon: WeaponId,
    swap: boolean,
  ): boolean {
    const matchId = this.byAccount.get(accountId);
    if (matchId === undefined) return false;
    return this.matches.get(matchId)?.runtime.load(accountId, boat, tube, weapon, swap) ?? false;
  }

  /** Mark a player connected or not. Their boats keep their orders either way (04 §5). */
  setConnected(accountId: AccountId, connected: boolean): void {
    const matchId = this.byAccount.get(accountId);
    if (matchId === undefined) return;
    const record = this.matches.get(matchId);
    if (record === undefined) return;
    const state = record.runtime.state;
    const players = state.players.map((player) =>
      player.accountId === accountId ? { ...player, connected } : player,
    );
    record.runtime.replace({ ...state, players });
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
    const team = teamFor(record.runtime.state, accountId);
    return record.chat.filter((entry) => canHear(entry, team));
  }

  /** Drop a match that has ended. */
  remove(matchId: MatchId): void {
    this.matches.delete(matchId);
  }
}
