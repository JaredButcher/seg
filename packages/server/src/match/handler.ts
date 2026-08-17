/**
 * @seg/server/match/handler — match traffic over the game protocol.
 *
 * The counterpart to `LobbyHandler`, and split the same way: `MatchStore` owns what the main
 * thread knows, the match's own worker thread owns the simulation and what a given player may
 * *see* of it, and this file owns the protocol.
 *
 * ## What moved out, and why the file got smaller
 *
 * `publish` used to live here — a frame per recipient, ten times a second, built from ground truth
 * this thread was holding. It is now on the match's thread (`worker/entry.ts`), because that is
 * where the state is and shipping the state here to project it would have been the expensive half
 * of threading with none of the benefit. What is left is the inbound half: decide whether a message
 * is well-formed and whether this connection is entitled to send it at all, then hand it across.
 *
 * ## Shape here, rules there
 *
 * The split is old but the boundary makes it load-bearing, so it is worth stating plainly. This
 * file refuses what is not **shaped** like a command — a boat id that is not an integer, an aim
 * point outside the map, a salvo naming two hundred tubes, a debug command on a match nobody turned
 * debug mode on for. `MatchRuntime` refuses what is not **allowed** — a boat this account does not
 * command, a tube that is reloading, a load this hull never fitted.
 *
 * The dividing line is simply whether the fleet is needed to answer, and this thread does not have
 * the fleet. It used to look up the boat and check `owner` before forwarding; that check now lives
 * beside the boats, which is where the rest of its family already was (`MatchRuntime.commands`).
 *
 * What has *not* changed: everything sent to a player is built for that player alone. There is no
 * shared object to broadcast, so there is no shared object that could contain the other side's
 * fleet (planning/01 §5).
 */

import {
  canHear,
  canSpeakOn,
  createChatMessage,
  createChatRejected,
  createDebugReading,
  createMatchResults,
  createMatchRejoinable,
  CHAT_BURST,
  CHAT_WINDOW_MS,
  describeChatProblem,
  isChatScope,
  isDeployableWeapon,
  isHullId,
  isDebugFieldKind,
  isTeamId,
  isThrottleNotch,
  isVec2,
  isWeaponId,
  normalizeChatText,
  pointInExtents,
  validateChatText,
  type AccountId,
  type ChatClientMessage,
  type ChatProblem,
  type DebugClientMessage,
  type DebugSetFieldMessage,
  type DebugProbeMessage,
  type DebugSetReachMessage,
  type DebugSetStatsMessage,
  type DebugSetVisionMessage,
  type DebugSpawnMessage,
  type EntityId,
  type MatchClientMessage,
  type MatchId,
  type MatchResults,
  type MatchSetActiveSonarMessage,
  type Message,
  type NavClientMessage,
  type WeaponClientMessage,
  type WeaponDropMessage,
  type WeaponFireMessage,
  type WeaponLoadMessage,
} from '@seg/shared';

import type { ConnectionRegistry, PlayerConnection } from '../realtime/connections.js';
import type { MatchStore } from './store.js';
import { teamOf, type MatchCommand, type MatchDigest } from './worker/protocol.js';

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
  'match.rejoin',
  'weapon.fire',
  'weapon.load',
  'weapon.drop',
  'debug.setVision',
  'debug.spawn',
  'debug.setField',
  'debug.setReach',
  'debug.probe',
  'debug.setStats',
]);

/** Whether this handler is the one that should answer a given message. */
export function isMatchMessage(
  msg: Message,
): msg is
  | ChatClientMessage
  | NavClientMessage
  | MatchClientMessage
  | WeaponClientMessage
  | DebugClientMessage {
  return MATCH_OPS.has(msg.t);
}

/**
 * The most tubes one salvo may name.
 *
 * A cap on a client-supplied array, not a game rule: the largest hull in the table has four
 * tubes and Extra Torpedo Tube adds one each, so nothing legitimate comes close. What it stops
 * is a crafted message asking the server to iterate a hundred thousand times before the tube
 * lookups all fail. Sixteen leaves the content tables room to grow by a factor of two.
 *
 * It matters more than it did: the array now crosses a thread boundary before anything rejects it,
 * so an uncapped one would be structured-cloned on the way.
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
   * A connection arrived. If its account is in a match, decide what it is owed.
   *
   * A match still running, where this account's own seat is *not* marked connected — because
   * it left deliberately (`departed`) or its last connection dropped (`detach`) and neither has
   * come back since — is answered with an offer to rejoin rather than a silent resume: the
   * player walked away from a HUD, or was dropped from one, and coming back to that same HUD
   * without asking is what `match.rejoin` exists to make a choice instead of an ambush.
   *
   * Everything else — a match already over, or one this account never stopped being an active
   * participant in (a tab replaced by another, say) — is resent the whole picture. A concluded
   * match still needs `match.state`: the results screen reads *whose* fleet is whose from it
   * (`ResultsScreen.tsx`, `activeSetup`), so "there's nothing live left to resume" is not the
   * same claim as "there's nothing left to send".
   */
  attach(connection: PlayerConnection): void {
    const digest = this.store.digestByAccount(connection.accountId);
    if (digest === undefined) return;

    const results = this.store.resultsFor(digest.matchId);
    const player = digest.players.find((candidate) => candidate.accountId === connection.accountId);

    if (results === undefined && player?.connected !== true) {
      const lobbyName = this.store.lobbyNameFor(digest.matchId);
      if (lobbyName !== undefined) {
        connection.send(createMatchRejoinable(digest.matchId, lobbyName));
      }
      return;
    }

    this.resume(connection, digest);

    // Last, and only for a match that is already over. A player who reconnects into one — a
    // dropped connection during the final salvo, or a tab reopened afterwards — would otherwise
    // land on a live HUD over a world that stopped, with nothing to say why.
    if (results !== undefined) connection.send(createMatchResults(results));
  }

  detach(accountId: AccountId): void {
    // The seat is held and the boats keep their standing orders (planning/01 §7, 04 §5).
    // Nothing here removes the player from the match.
    this.store.setConnected(accountId, false, null);
    this.chatTimes.delete(accountId);
  }

  /**
   * The account left the lobby it played this match from (`lobby.leave`, mid-match) — called
   * via the callback `LobbyHandler` is given, so the lobby layer never has to know a match
   * exists. Unlike `detach`, the socket is still open: there is somebody to tell right now,
   * so this is also where the rejoin offer for *this* tab comes from — a reconnect (`attach`)
   * is the only other way to receive one, and there will not be one of those for a socket that
   * never closed.
   */
  departed(accountId: AccountId): void {
    const digest = this.store.digestByAccount(accountId);
    if (digest === undefined) return;
    this.store.setConnected(accountId, false, null);
    if (this.store.resultsFor(digest.matchId) !== undefined) return;

    const lobbyName = this.store.lobbyNameFor(digest.matchId);
    if (lobbyName !== undefined) {
      this.connections.tell(accountId, createMatchRejoinable(digest.matchId, lobbyName));
    }
  }

  /**
   * The account has committed to a different lobby (`lobby.create`/`lobby.join`) — called via
   * the same kind of callback as `departed`. Whatever match it used to be seated in stops being
   * theirs: not to rejoin (the store's index no longer names it, so a future `attach` finds
   * nothing to offer) and not to route a command to.
   */
  abandon(accountId: AccountId): void {
    this.store.release(accountId);
  }

  /**
   * The player asked to pick a departed match back up (`match.rejoin`, the button on the main
   * menu). Refused silently if there is nothing to rejoin, or it already ended — the button
   * that sent this either already knew, or is about to be told (`match.results`).
   */
  rejoin(connection: PlayerConnection): void {
    const digest = this.store.digestByAccount(connection.accountId);
    if (digest === undefined || this.store.resultsFor(digest.matchId) !== undefined) return;
    this.resume(connection, digest);
  }

  /**
   * A match has begun: everyone in it is marked present, which is what makes the match's own
   * thread start sending them frames.
   *
   * Called by whatever composed the start (see `app.ts`), rather than by the lobby handler, so
   * the lobby keeps knowing nothing about match payloads.
   *
   * Takes an id rather than a state on purpose. The match has to be in the store before anyone is
   * told about it — that is where a reconnecting player will look for it — and a signature that
   * accepted a loose state would let a caller announce a match nobody could then find.
   */
  begin(matchId: MatchId): void {
    const digest = this.store.digest(matchId);
    if (digest === undefined) return;
    for (const player of digest.players) {
      const connection = this.connections.get(player.accountId);
      if (connection === undefined) continue;
      this.resume(connection, digest);
    }
  }

  /**
   * A match has ended: everyone in it is told how, and told the same thing.
   *
   * Subscribed to `MatchStore` (see `app.ts`) and driven by the worker's own decision, rather than
   * polled by a clock walking every match as it used to be. Exactly-once is the store's guarantee —
   * it records the results the first time and calls nobody after.
   *
   * One object for all of them, unlike everything else this handler sends. The match is over, so
   * there is nothing left to withhold and the whole point of the screen is the reveal
   * (`match/results.ts`). Nobody is removed from anything: the player is still seated in the lobby
   * they started from, and leaving the results screen is an ordinary `lobby.leave`.
   */
  conclude(_matchId: MatchId, results: MatchResults): void {
    const message = createMatchResults(results);
    for (const player of results.players) {
      this.connections.tell(player.accountId, message);
    }
  }

  /**
   * A match's thread died without producing results (`MatchStore.onLost`).
   *
   * The failure mode that only exists now that matches run on threads, and the only one in the
   * server with no good answer. There is nothing to salvage: the single copy of the state was in
   * that isolate, so the match cannot be resumed, replayed, or scored.
   *
   * What this does is make sure nothing *dangles*. Every seat is released, so the account index
   * stops naming a match that is gone and the next `attach` gives the player a clean main menu
   * instead of an offer to rejoin something that no longer exists.
   *
   * **What it does not do is tell anyone who is looking at the HUD right now**, because the
   * protocol has no message for "this match was lost" — `match.results` would have to invent an
   * outcome, and `lobby.rejected` answers a request nobody made. Those players keep a scope that
   * has stopped updating until they leave it by hand. Closing that gap means a new
   * `MatchServerMessage` and a client screen to receive it, which is a deliberate piece of work
   * rather than something to smuggle in here. Until then this is logged loudly and the operator is
   * the one who finds out.
   */
  lost(matchId: MatchId): void {
    const digest = this.store.digest(matchId);
    if (digest === undefined) return;
    for (const player of digest.players) this.store.release(player.accountId);
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────────

  handle(
    connection: PlayerConnection,
    msg:
      | ChatClientMessage
      | NavClientMessage
      | MatchClientMessage
      | WeaponClientMessage
      | DebugClientMessage,
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
      case 'match.rejoin':
        this.rejoin(connection);
        return;
      case 'weapon.fire':
        this.fire(connection, msg);
        return;
      case 'weapon.load':
        this.load(connection, msg);
        return;
      case 'weapon.drop':
        this.drop(connection, msg);
        return;
      case 'debug.setVision':
        this.debugSetVision(connection, msg);
        return;
      case 'debug.spawn':
        this.debugSpawn(connection, msg);
        return;
      case 'debug.setField':
        this.debugSetField(connection, msg);
        return;
      case 'debug.setReach':
        this.debugSetReach(connection, msg);
        return;
      case 'debug.probe':
        void this.debugProbe(connection, msg);
        return;
      case 'debug.setStats':
        this.debugSetStats(connection, msg);
        return;
    }
  }

  // ── Weapons ───────────────────────────────────────────────────────────────────

  /**
   * Fire a salvo at a point on the map.
   *
   * Nothing is sent back, for the reason `setActiveSonar` gives: the view frame the player is
   * already receiving carries the tubes going into reload and the weapons appearing in the water,
   * so a refused shot is simply one where nothing moves. The runtime refuses a boat this account
   * does not command and a tube that is not loaded; this refuses a message that is not shaped
   * like a fire command, and an aim point off the map — the camera cannot present one, so an
   * out-of-map shot is a client bug or worse.
   *
   * Every field is validated rather than trusted. `JsonCodec` checks the type tag and nothing
   * else, and this is the first message carrying an array a client chose.
   */
  private fire(connection: PlayerConnection, msg: WeaponFireMessage): void {
    const digest = this.playing(connection);
    if (digest === undefined) return;
    if (!isEntityId(msg.boat)) return;
    if (!isVec2(msg.to) || !pointInExtents(msg.to, digest.extents)) return;
    if (!Array.isArray(msg.tubes) || msg.tubes.length > MAX_SALVO) return;

    const tubes: number[] = [];
    for (const index of msg.tubes) {
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return;
      tubes.push(index);
    }

    this.send(connection, { t: 'fire', boat: msg.boat, tubes, to: msg.to });
  }

  /**
   * Drop a boat's noisemaker.
   *
   * Nothing to validate past the boat itself: the message has no other fields, because there is no
   * tube to name and nowhere to aim (`protocol/weapon.ts#WeaponDropMessage`). Nothing is sent back
   * either, for the reason `fire` gives — the launcher going into reload and the noisemaker
   * appearing in the water are the receipt, and a refused drop is one where neither happens.
   */
  private drop(connection: PlayerConnection, msg: WeaponDropMessage): void {
    if (this.playing(connection) === undefined) return;
    if (!isEntityId(msg.boat)) return;

    this.send(connection, { t: 'drop', boat: msg.boat });
  }

  /** Choose a tube's next load, or eject and replace what it is holding. */
  private load(connection: PlayerConnection, msg: WeaponLoadMessage): void {
    if (this.playing(connection) === undefined) return;
    if (!isEntityId(msg.boat)) return;
    if (typeof msg.tube !== 'number' || !Number.isInteger(msg.tube) || msg.tube < 0) return;
    if (!isWeaponId(msg.weapon) || typeof msg.swap !== 'boolean') return;

    this.send(connection, {
      t: 'load',
      boat: msg.boat,
      tube: msg.tube,
      weapon: msg.weapon,
      swap: msg.swap,
    });
  }

  // ── Commands ──────────────────────────────────────────────────────────────────

  /**
   * Throw a boat's active sonar switch.
   *
   * Nothing is sent back. The runtime refuses a boat this account does not command, a boat that
   * is already in the requested state, and a wreck — and in every one of those cases the right
   * answer is the view frame the player is already receiving, which will simply not show the
   * switch move. A dedicated rejection would be a message class existing for a case a correct
   * client cannot produce, and chat has one only because a *human* can produce its failures.
   *
   * The shape is validated rather than trusted: this is the first message carrying an entity id
   * a client chose, and `JsonCodec` checks the type tag and nothing else.
   */
  private setActiveSonar(connection: PlayerConnection, msg: MatchSetActiveSonarMessage): void {
    if (!isEntityId(msg.boat)) return;
    if (typeof msg.active !== 'boolean') return;
    this.send(connection, { t: 'sonar', boat: msg.boat, active: msg.active });
  }

  // ── Navigation ────────────────────────────────────────────────────────────────

  /**
   * Order a boat somewhere, appending to its route when the click was shifted.
   *
   * The command is only legal for a boat the sender commands, that is still in the water, and
   * for a point inside the map — the camera cannot present an out-of-map point, so an out-of-map
   * order is a client bug (or worse) and the honest answer is to drop it. The first two of those
   * are settled where the boats are (`MatchRuntime.commands`); the map bound is settled here,
   * because the digest carries it and a nonsense point should not cost a thread hop.
   */
  private order(
    connection: PlayerConnection,
    rawBoat: unknown,
    rawTo: unknown,
    queue: boolean,
  ): void {
    const digest = this.playing(connection);
    if (digest === undefined) return;
    if (!isEntityId(rawBoat)) return;
    if (!isVec2(rawTo) || !pointInExtents(rawTo, digest.extents)) return;

    this.send(connection, { t: 'order', boat: rawBoat, to: rawTo, queue });
  }

  private cancelOrders(connection: PlayerConnection, rawBoat: unknown): void {
    if (this.playing(connection) === undefined) return;
    if (!isEntityId(rawBoat)) return;
    this.send(connection, { t: 'cancel', boat: rawBoat });
  }

  private throttle(connection: PlayerConnection, rawBoat: unknown, rawNotch: unknown): void {
    if (this.playing(connection) === undefined) return;
    if (!isEntityId(rawBoat)) return;
    if (!isThrottleNotch(rawNotch)) return;
    this.send(connection, { t: 'throttle', boat: rawBoat, notch: rawNotch });
  }

  // ── Debug console ─────────────────────────────────────────────────────────────

  /**
   * Throw the sender's own fog of war off or back on (`debug.setVision`).
   *
   * Refused outright on a match that was not started with `LobbySettings.debugMode` — the one
   * gate every command in this section shares, checked here rather than trusted from the
   * client, exactly like every other rule in this file. The gate is on the digest, so it is one
   * of the few things this thread can still refuse on its own.
   */
  private debugSetVision(connection: PlayerConnection, msg: DebugSetVisionMessage): void {
    if (this.debugging(connection) === undefined) return;
    if (typeof msg.enabled !== 'boolean') return;
    this.send(connection, { t: 'debug.vision', enabled: msg.enabled });
  }

  /**
   * Draw one acoustic field for this connection, or stop drawing any (`debug.setField`).
   *
   * Same `debugMode` gate as the two beside it, and nothing is sent back in answer: the overlay
   * appearing *is* the acknowledgement, and switching it off is confirmed by the payloads
   * stopping.
   *
   * The named boat is checked for *shape* and no further. Whether it exists, is afloat, or is on
   * the sender's side is settled where the field is measured, because all three can change between
   * the request and the next tick — and a debug player may ask about either fleet, which is the
   * whole point of a tool for balancing two of them against each other.
   */
  private debugSetField(connection: PlayerConnection, msg: DebugSetFieldMessage): void {
    if (this.debugging(connection) === undefined) return;
    if (msg.kind !== null && !isDebugFieldKind(msg.kind)) return;
    if (msg.boat !== null && !Number.isSafeInteger(msg.boat)) return;
    this.send(connection, { t: 'debug.field', kind: msg.kind, boat: msg.boat });
  }

  /**
   * Draw the ping-reach rings for this connection, or stop (`debug.setReach`).
   *
   * The same `debugMode` gate and the same silence as the two above: the rings arriving is the
   * acknowledgement, and switching them off is confirmed by them stopping.
   */
  private debugSetReach(connection: PlayerConnection, msg: DebugSetReachMessage): void {
    if (this.debugging(connection) === undefined) return;
    if (typeof msg.enabled !== 'boolean') return;
    this.send(connection, { t: 'debug.reach', enabled: msg.enabled });
  }

  /**
   * Open or close the statistics panel for this connection (`debug.setStats`).
   *
   * The same `debugMode` gate and the same silence as the switches above it. This one also arms
   * the match thread's own stopwatch, which is why it is refused rather than ignored on a match
   * nobody turned debug mode on for: the cost of measuring is small, and it is not zero.
   */
  private debugSetStats(connection: PlayerConnection, msg: DebugSetStatsMessage): void {
    if (this.debugging(connection) === undefined) return;
    if (typeof msg.enabled !== 'boolean') return;
    this.send(connection, { t: 'debug.stats', enabled: msg.enabled });
  }

  /**
   * Read one point of water out in full, for the connection that asked (`debug.probe`).
   *
   * **The one command in this file that answers**, and therefore the only one that crosses the
   * thread boundary and waits. The others change what a connection is sent from then on, and their
   * acknowledgement is the overlay appearing.
   *
   * Answered on this socket rather than queued for the publishing loop — a probe is somebody
   * clicking on the water with a panel open, and a reading that waited for the next frame would be
   * measured against a world that had moved. The await costs one hop, which is a fraction of the
   * 100 ms a frame would have cost.
   *
   * The point is checked against the map for the reason `fire` checks its aim point. A request that
   * cannot be answered gets nothing at all, and the panel keeps the last reading it had — the
   * previous answer is still the last thing that was true.
   */
  private async debugProbe(connection: PlayerConnection, msg: DebugProbeMessage): Promise<void> {
    const digest = this.debugging(connection);
    if (digest === undefined) return;
    if (!isVec2(msg.at) || !pointInExtents(msg.at, digest.extents)) return;
    if (msg.boat !== null && !Number.isSafeInteger(msg.boat)) return;

    const answer = await this.store.probe(connection.accountId, msg.boat, msg.at);
    if (answer?.reading == null) return;
    connection.send(createDebugReading(digest.matchId, answer.tick, answer.reading));
  }

  /**
   * Put a sub or a torpedo in the water at a point (`debug.spawn`).
   *
   * Same `debugMode` gate as `debugSetVision`, plus the shape checks every wire-supplied entity
   * gets elsewhere in this file: a real team, a point on the map, and a subtype that is a real
   * hull for a sub or a *deployable* weapon for a torpedo — the same rule the tube picker and
   * `fire()` already enforce, so a debug spawn cannot put a load in the water the weapons phase
   * does not know how to run.
   */
  private debugSpawn(connection: PlayerConnection, msg: DebugSpawnMessage): void {
    const digest = this.debugging(connection);
    if (digest === undefined) return;
    if (!isTeamId(msg.team)) return;
    if (!isVec2(msg.at) || !pointInExtents(msg.at, digest.extents)) return;

    if (msg.kind === 'sub') {
      if (!isHullId(msg.subtype)) return;
      this.send(connection, {
        t: 'debug.spawn',
        kind: 'sub',
        subtype: msg.subtype,
        team: msg.team,
        at: msg.at,
      });
      return;
    }
    if (msg.kind === 'torpedo') {
      if (!isWeaponId(msg.subtype) || !isDeployableWeapon(msg.subtype)) return;
      this.send(connection, {
        t: 'debug.spawn',
        kind: 'torpedo',
        subtype: msg.subtype,
        team: msg.team,
        at: msg.at,
      });
    }
  }

  // ── Chat ──────────────────────────────────────────────────────────────────────

  private chat(connection: PlayerConnection, rawScope: unknown, rawText: unknown): void {
    const digest = this.store.digestByAccount(connection.accountId);
    if (digest === undefined) return;

    if (!isChatScope(rawScope) || typeof rawText !== 'string') {
      this.rejectChat(connection, 'wrong_scope');
      return;
    }

    const team = teamOf(digest, connection.accountId);
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

    const entry = this.store.addChat(digest.matchId, {
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
    for (const player of digest.players) {
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

  // ── Shared guards ─────────────────────────────────────────────────────────────

  /** The match this connection is seated in, or `undefined` — the guard every command shares. */
  private playing(connection: PlayerConnection): MatchDigest | undefined {
    return this.store.digestByAccount(connection.accountId);
  }

  /** The same, plus the `debugMode` gate every command in the console section shares. */
  private debugging(connection: PlayerConnection): MatchDigest | undefined {
    const digest = this.playing(connection);
    if (digest === undefined || !digest.debugMode) return undefined;
    return digest;
  }

  private send(connection: PlayerConnection, cmd: MatchCommand): void {
    this.store.command(connection.accountId, cmd);
  }

  // ── Sending ───────────────────────────────────────────────────────────────────

  /**
   * Put a connection back in the match: mark it present, reset its chart, resend the picture.
   *
   * The setup and the view frame are built on the match's own thread and arrive as bytes a moment
   * later; the chat backlog is sent from here, because chat never left this thread. The two
   * therefore interleave, and that is fine rather than merely tolerated — the client folds a chat
   * line into a list keyed by id and deduplicated (`state/match.ts#receivedChat`), and nothing in
   * `receivedSetup` touches it. If that ever stops being true, this is the comment that was wrong.
   *
   * The chart reset is what makes the frames that follow carry the whole thing rather than only
   * what the team confirmed while this connection was away.
   */
  private resume(connection: PlayerConnection, digest: MatchDigest): void {
    this.store.setConnected(connection.accountId, true, connection.codec);
    this.store.resetVision(connection.accountId);
    this.store.resend(connection.accountId);

    for (const entry of this.store.chatFor(digest.matchId, connection.accountId)) {
      connection.send(createChatMessage(entry));
    }
  }
}

/** A boat id off the wire: an integer, and nothing more is knowable without the fleet. */
function isEntityId(value: unknown): value is EntityId {
  return typeof value === 'number' && Number.isInteger(value);
}
