/**
 * @seg/server/match/handler — match traffic over the game protocol.
 *
 * The counterpart to `LobbyHandler`, and split the same way: `MatchStore` owns the state,
 * `@seg/shared/match/view` owns what a given player may know about it, and this file owns the
 * protocol and decides who hears what. No rule is enforced in two places.
 *
 * Everything it sends is built **per recipient**. That is not a convention here, it is the
 * mechanism: a broadcast of one shared object is how an enemy fleet ends up in a devtools
 * inspector, so there is no shared object to broadcast (planning/01 §5).
 */

import {
  canHear,
  canSpeakOn,
  createChatMessage,
  createChatRejected,
  createMatchResults,
  createMatchState,
  createMatchView,
  CHAT_BURST,
  CHAT_WINDOW_MS,
  describeChatProblem,
  isChatScope,
  isThrottleNotch,
  isVec2,
  isWeaponId,
  normalizeChatText,
  pointInExtents,
  setupFor,
  teamFor,
  validateChatText,
  type AccountId,
  type BoatState,
  type ChatClientMessage,
  type ChatProblem,
  type MatchClientMessage,
  type MatchId,
  type MatchState,
  type Message,
  type NavClientMessage,
  type WeaponClientMessage,
  type WeaponFireMessage,
  type WeaponLoadMessage,
} from '@seg/shared';

import type { ConnectionRegistry, PlayerConnection } from '../realtime/connections.js';
import type { MatchStore } from './store.js';

export interface MatchHandlerOptions {
  readonly store: MatchStore;
  readonly connections: ConnectionRegistry;
  /** Injected so tests control time without sleeping (planning/13 §13). */
  readonly clock?: () => number;
}

const MATCH_OPS = new Set<string>([
  'chat.send',
  'nav.order',
  'nav.cancel',
  'nav.throttle',
  'match.setActiveSonar',
  'weapon.fire',
  'weapon.load',
]);

/** Whether this handler is the one that should answer a given message. */
export function isMatchMessage(
  msg: Message,
): msg is ChatClientMessage | NavClientMessage | MatchClientMessage | WeaponClientMessage {
  return MATCH_OPS.has(msg.t);
}

/**
 * The most tubes one salvo may name.
 *
 * A cap on a client-supplied array, not a game rule: the largest hull in the table has four
 * tubes and Extra Torpedo Tube adds one each, so nothing legitimate comes close. What it stops
 * is a crafted message asking the server to iterate a hundred thousand times before the tube
 * lookups all fail. Sixteen leaves the content tables room to grow by a factor of two.
 */
const MAX_SALVO = 16;

export class MatchHandler {
  private readonly store: MatchStore;
  private readonly connections: ConnectionRegistry;
  private readonly clock: () => number;
  /** Recent send times per account, for the chat token bucket (planning/02 §7). */
  private readonly chatTimes = new Map<AccountId, number[]>();

  constructor(options: MatchHandlerOptions) {
    this.store = options.store;
    this.connections = options.connections;
    this.clock = options.clock ?? (() => Date.now());
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────────

  /**
   * A connection arrived. If its account is in a running match, tell it everything about that
   * match it is allowed to know.
   *
   * This is the reconnect path (Q21) and it is why `match.state` is separate from
   * `match.started`: the payload does not change when the event happens again, so a returning
   * player is re-sent the state and a fresh view frame without the match having restarted.
   * Chat backlog comes too — a player who dropped for thirty seconds should not come back to
   * an empty panel and wonder what they missed.
   */
  attach(connection: PlayerConnection): void {
    this.store.setConnected(connection.accountId, true);
    const state = this.store.findByAccount(connection.accountId);
    if (state === undefined) return;
    // The returning client is a fresh tab: whatever chart its team has built, this connection
    // has been told none of it. Resetting the watermark is what makes the frames that follow
    // carry the whole thing rather than only what was confirmed while it was away.
    this.store.resetVision(connection.accountId);
    this.sendMatch(connection, state);
  }

  detach(accountId: AccountId): void {
    // The seat is held and the boats keep their standing orders (planning/01 §7, 04 §5).
    // Nothing here removes the player from the match.
    this.store.setConnected(accountId, false);
    this.chatTimes.delete(accountId);
  }

  /**
   * A match has begun: everyone in it gets their own setup and their first view frame.
   *
   * Called by whatever composed the start (see `app.ts`), rather than by the lobby handler,
   * so the lobby keeps knowing nothing about match payloads.
   *
   * Takes an id rather than a state on purpose. The match has to be in the store before
   * anyone is told about it — that is where view sequences are counted and where a
   * reconnecting player will look for it — and a signature that accepted a loose state would
   * let a caller announce a match nobody could then find.
   */
  begin(matchId: MatchId): void {
    const state = this.store.find(matchId);
    if (state === undefined) return;
    for (const player of state.players) {
      const connection = this.connections.get(player.accountId);
      if (connection === undefined) continue;
      this.sendMatch(connection, state);
    }
  }

  /**
   * One view frame to everyone connected to a match. Called by the clock, at 10 Hz.
   *
   * Built per recipient — a frame carries the chart *that connection* is still owed, and the
   * boats *that player* commands — so there is no shared object to broadcast and therefore no
   * shared object that could contain the other side's fleet (planning/01 §5).
   *
   * A player whose socket is down is skipped rather than queued. Their boats keep their
   * standing orders and their seat is held (planning/01 §7); what they miss is a picture that
   * was stale 100 ms later anyway, and `attach` gives them a fresh one plus the whole chart.
   */
  publish(matchId: MatchId): void {
    const state = this.store.find(matchId);
    if (state === undefined) return;

    for (const player of state.players) {
      const connection = this.connections.get(player.accountId);
      if (connection === undefined) continue;
      const frame = this.store.viewFor(matchId, player.accountId);
      if (frame === undefined) continue;
      connection.send(createMatchView(matchId, frame.seq, frame.view));
    }
  }

  /**
   * A match has ended: everyone in it is told how, and told the same thing.
   *
   * Called by the clock on the tick the runtime decided (`MatchRuntime.results`), and exactly
   * once — `MatchStore.conclude` answers the first caller and nobody after, so a driver that
   * walks every match on every tick cannot announce one twice.
   *
   * One object for all of them, unlike everything else this handler sends. The match is over,
   * so there is nothing left to withhold and the whole point of the screen is the reveal
   * (`match/results.ts`). Nobody is removed from anything: the player is still seated in the
   * lobby they started from, and leaving the results screen is an ordinary `lobby.leave`.
   */
  conclude(matchId: MatchId): void {
    const results = this.store.conclude(matchId);
    if (results === undefined) return;

    const message = createMatchResults(results);
    for (const player of results.players) {
      this.connections.tell(player.accountId, message);
    }
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────────

  handle(
    connection: PlayerConnection,
    msg: ChatClientMessage | NavClientMessage | MatchClientMessage | WeaponClientMessage,
  ): void {
    switch (msg.t) {
      case 'chat.send':
        this.chat(connection, msg.scope, msg.text);
        return;
      case 'nav.order':
        this.order(connection, msg.boat, msg.to, msg.queue);
        return;
      case 'nav.cancel':
        this.cancelOrders(connection, msg.boat);
        return;
      case 'nav.throttle':
        this.throttle(connection, msg.boat, msg.notch);
        return;
      case 'match.setActiveSonar':
        this.setActiveSonar(connection, msg);
        return;
      case 'weapon.fire':
        this.fire(connection, msg);
        return;
      case 'weapon.load':
        this.load(connection, msg);
        return;
    }
  }

  // ── Weapons ───────────────────────────────────────────────────────────────────

  /**
   * Fire a salvo at a point on the map.
   *
   * Nothing is sent back, for the reason `setActiveSonar` gives: the view frame the player is
   * already receiving carries the tubes going into reload and the weapons appearing in the water,
   * so a refused shot is simply one where nothing moves. The store refuses a boat this account
   * does not command and a tube that is not loaded; this refuses a message that is not shaped
   * like a fire command, and an aim point off the map — the camera cannot present one, so an
   * out-of-map shot is a client bug or worse.
   *
   * Every field is validated rather than trusted. `JsonCodec` checks the type tag and nothing
   * else, and this is the first message carrying an array a client chose.
   */
  private fire(connection: PlayerConnection, msg: WeaponFireMessage): void {
    const state = this.store.findByAccount(connection.accountId);
    if (state === undefined) return;
    const boat = this.commandedBoat(state, connection.accountId, msg.boat);
    if (boat === undefined || boat.status === 'destroyed') return;
    if (!isVec2(msg.to) || !pointInExtents(msg.to, state.map.extents)) return;
    if (!Array.isArray(msg.tubes) || msg.tubes.length > MAX_SALVO) return;

    const tubes: number[] = [];
    for (const index of msg.tubes) {
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return;
      tubes.push(index);
    }

    this.store.fire(connection.accountId, boat.id, tubes, msg.to);
  }

  /** Choose a tube's next load, or eject and replace what it is holding. */
  private load(connection: PlayerConnection, msg: WeaponLoadMessage): void {
    const state = this.store.findByAccount(connection.accountId);
    if (state === undefined) return;
    const boat = this.commandedBoat(state, connection.accountId, msg.boat);
    if (boat === undefined || boat.status === 'destroyed') return;
    if (typeof msg.tube !== 'number' || !Number.isInteger(msg.tube) || msg.tube < 0) return;
    if (!isWeaponId(msg.weapon) || typeof msg.swap !== 'boolean') return;

    this.store.load(connection.accountId, boat.id, msg.tube, msg.weapon, msg.swap);
  }

  // ── Commands ──────────────────────────────────────────────────────────────────

  /**
   * Throw a boat's active sonar switch.
   *
   * Nothing is sent back. The store refuses a boat this account does not command, a boat that
   * is already in the requested state, and a wreck — and in every one of those cases the right
   * answer is the view frame the player is already receiving, which will simply not show the
   * switch move. A dedicated rejection would be a message class existing for a case a correct
   * client cannot produce, and chat has one only because a *human* can produce its failures.
   *
   * The shape is validated rather than trusted: this is the first message carrying an entity id
   * a client chose, and `JsonCodec` checks the type tag and nothing else.
   */
  private setActiveSonar(connection: PlayerConnection, msg: MatchClientMessage): void {
    if (typeof msg.boat !== 'number' || !Number.isInteger(msg.boat)) return;
    if (typeof msg.active !== 'boolean') return;
    this.store.setActiveSonar(connection.accountId, msg.boat, msg.active);
  }

  // ── Navigation ────────────────────────────────────────────────────────────────

  /**
   * Order a boat somewhere, appending to its route when the click was shifted.
   *
   * The command is only legal for a boat the sender commands, that is still in the water, and
   * for a point inside the map — the camera cannot present an out-of-map point, so an out-of-map
   * order is a client bug (or worse) and the honest answer is to drop it.
   */
  private order(
    connection: PlayerConnection,
    rawBoat: unknown,
    rawTo: unknown,
    queue: boolean,
  ): void {
    const state = this.store.findByAccount(connection.accountId);
    if (state === undefined) return;
    const boat = this.commandedBoat(state, connection.accountId, rawBoat);
    if (boat === undefined || boat.status === 'destroyed') return;
    if (!isVec2(rawTo)) return;
    if (!pointInExtents(rawTo, state.map.extents)) return;

    const runtime = this.store.runtime(state.matchId);
    runtime?.order(boat.id, rawTo, queue);
  }

  private cancelOrders(connection: PlayerConnection, rawBoat: unknown): void {
    const state = this.store.findByAccount(connection.accountId);
    if (state === undefined) return;
    const boat = this.commandedBoat(state, connection.accountId, rawBoat);
    if (boat === undefined) return;

    const runtime = this.store.runtime(state.matchId);
    runtime?.cancel(boat.id);
  }

  private throttle(connection: PlayerConnection, rawBoat: unknown, rawNotch: unknown): void {
    const state = this.store.findByAccount(connection.accountId);
    if (state === undefined) return;
    const boat = this.commandedBoat(state, connection.accountId, rawBoat);
    if (boat === undefined) return;
    if (!isThrottleNotch(rawNotch)) return;

    const runtime = this.store.runtime(state.matchId);
    runtime?.setThrottle(boat.id, rawNotch);
  }

  /** The boat this account commands, or `undefined` when the id is not theirs or not there. */
  private commandedBoat(
    state: MatchState,
    accountId: AccountId,
    rawBoat: unknown,
  ): BoatState | undefined {
    const boat = state.boats.find((candidate) => candidate.id === rawBoat);
    if (boat === undefined || boat.owner !== accountId) return undefined;
    return boat;
  }

  // ── Chat ──────────────────────────────────────────────────────────────────────

  private chat(connection: PlayerConnection, rawScope: unknown, rawText: unknown): void {
    const state = this.store.findByAccount(connection.accountId);
    if (state === undefined) return;

    if (!isChatScope(rawScope) || typeof rawText !== 'string') {
      this.rejectChat(connection, 'wrong_scope');
      return;
    }

    const team = teamFor(state, connection.accountId);
    if (!canSpeakOn(rawScope, team)) {
      this.rejectChat(connection, 'wrong_scope');
      return;
    }

    const text = normalizeChatText(rawText);
    const problem = validateChatText(text);
    if (problem !== null) {
      this.rejectChat(connection, problem);
      return;
    }
    if (!this.allowChat(connection.accountId)) {
      this.rejectChat(connection, 'rate_limited');
      return;
    }

    const entry = this.store.addChat(state.matchId, {
      from: connection.accountId,
      username: connection.username,
      team,
      scope: rawScope,
      text,
      at: this.clock(),
    });
    if (entry === undefined) return;

    // Fanned out by audience rather than broadcast: a team line never reaches the other side,
    // and the filter runs here rather than on the client, where it would be a suggestion.
    const message = createChatMessage(entry);
    for (const player of state.players) {
      if (!canHear(entry, player.team)) continue;
      this.connections.tell(player.accountId, message);
    }
  }

  /**
   * The chat token bucket: `CHAT_BURST` lines per `CHAT_WINDOW_MS` (planning/02 §7).
   *
   * A sliding window of send times rather than a refilling counter, because the window is
   * five seconds and the list is three entries — the simple thing is also the cheap thing,
   * and it cannot drift the way a timer-refilled bucket can when nothing is being sent.
   */
  private allowChat(accountId: AccountId): boolean {
    const now = this.clock();
    const recent = (this.chatTimes.get(accountId) ?? []).filter((at) => now - at < CHAT_WINDOW_MS);
    if (recent.length >= CHAT_BURST) {
      this.chatTimes.set(accountId, recent);
      return false;
    }
    recent.push(now);
    this.chatTimes.set(accountId, recent);
    return true;
  }

  private rejectChat(connection: PlayerConnection, problem: ChatProblem): void {
    connection.send(createChatRejected(problem, describeChatProblem(problem)));
  }

  // ── Sending ───────────────────────────────────────────────────────────────────

  /**
   * The full picture for one recipient: setup, a view frame, and the chat they can read.
   *
   * The setup is projected from the state in hand rather than looked up again — the caller
   * already has the state, and a second lookup would introduce a "what if it is gone" branch
   * whose only honest handling is to send nothing at all.
   */
  private sendMatch(connection: PlayerConnection, state: MatchState): void {
    connection.send(createMatchState(setupFor(state, connection.accountId)));

    const frame = this.store.viewFor(state.matchId, connection.accountId);
    if (frame !== undefined) {
      connection.send(createMatchView(state.matchId, frame.seq, frame.view));
    }

    for (const entry of this.store.chatFor(state.matchId, connection.accountId)) {
      connection.send(createChatMessage(entry));
    }

    // Last, and only for a match that is already over. A player who reconnects into one — a
    // dropped connection during the final salvo, or a tab reopened afterwards — would otherwise
    // land on a live HUD over a world that stopped, with nothing to say why.
    const results = this.store.resultsFor(state.matchId);
    if (results !== undefined) connection.send(createMatchResults(results));
  }
}
