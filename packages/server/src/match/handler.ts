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
  createDebugField,
  createDebugReach,
  createChatMessage,
  createChatRejected,
  createMatchResults,
  createMatchRejoinable,
  createMatchState,
  createMatchView,
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
  FIELD_MAP_HZ,
  normalizeChatText,
  pointInExtents,
  SIM_TICK_HZ,
  setupFor,
  teamFor,
  validateChatText,
  type AccountId,
  type BoatState,
  type ChatClientMessage,
  type ChatProblem,
  type DebugClientMessage,
  type DebugSetFieldMessage,
  type DebugSetReachMessage,
  type DebugSetVisionMessage,
  type DebugSpawnMessage,
  type MatchClientMessage,
  type MatchId,
  type MatchSetActiveSonarMessage,
  type MatchState,
  type Message,
  type NavClientMessage,
  type FieldMapView,
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
  'match.rejoin',
  'weapon.fire',
  'weapon.load',
  'debug.setVision',
  'debug.spawn',
  'debug.setField',
  'debug.setReach',
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
 */
const MAX_SALVO = 16;

/**
 * Sim ticks between acoustic-field sends, from the rate the payload itself declares.
 *
 * Derived here rather than in `match/field.ts` because the tick rate is the server's number and
 * that file is shared with the decoder. A field is read rather than reacted to, and it is two
 * orders of magnitude larger than a view frame, so it goes at the slowest rate that still
 * animates — see the header there.
 */
const FIELD_TICKS = Math.max(1, Math.round(SIM_TICK_HZ / FIELD_MAP_HZ));

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
    const state = this.store.findByAccount(connection.accountId);
    if (state === undefined) return;

    const results = this.store.resultsFor(state.matchId);
    const player = state.players.find((candidate) => candidate.accountId === connection.accountId);

    if (results === undefined && player?.connected !== true) {
      const lobbyName = this.store.lobbyNameFor(state.matchId);
      if (lobbyName !== undefined) {
        connection.send(createMatchRejoinable(state.matchId, lobbyName));
      }
      return;
    }

    this.store.setConnected(connection.accountId, true);
    // The returning client is a fresh tab: whatever chart its team has built, this connection
    // has been told none of it. Resetting the watermark is what makes the frames that follow
    // carry the whole thing rather than only what was confirmed while it was away.
    this.store.resetVision(connection.accountId);
    this.sendMatch(connection, state);

    // Last, and only for a match that is already over. A player who reconnects into one — a
    // dropped connection during the final salvo, or a tab reopened afterwards — would otherwise
    // land on a live HUD over a world that stopped, with nothing to say why.
    if (results !== undefined) connection.send(createMatchResults(results));
  }

  detach(accountId: AccountId): void {
    // The seat is held and the boats keep their standing orders (planning/01 §7, 04 §5).
    // Nothing here removes the player from the match.
    this.store.setConnected(accountId, false);
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
    const state = this.store.findByAccount(accountId);
    if (state === undefined) return;
    this.store.setConnected(accountId, false);
    if (this.store.resultsFor(state.matchId) !== undefined) return;

    const lobbyName = this.store.lobbyNameFor(state.matchId);
    if (lobbyName !== undefined) {
      this.connections.tell(accountId, createMatchRejoinable(state.matchId, lobbyName));
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
    const state = this.store.findByAccount(connection.accountId);
    if (state === undefined || this.store.resultsFor(state.matchId) !== undefined) return;
    this.store.setConnected(connection.accountId, true);
    this.store.resetVision(connection.accountId);
    this.sendMatch(connection, state);
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
   * A player whose socket is down, or who has left, is skipped rather than queued. Their boats
   * keep their standing orders and their seat is held (planning/01 §7); what they miss is a
   * picture that was stale 100 ms later anyway, and `attach`/`rejoin` gives them a fresh one
   * plus the whole chart. Gated on `connected` as well as on having a live connection: a
   * deliberate leave (`departed`) holds the socket open, and without this check a player
   * sitting on the main menu would keep drawing view frames for a HUD they walked away from.
   */
  publish(matchId: MatchId): void {
    const state = this.store.find(matchId);
    if (state === undefined) return;

    // The debug overlays, at their own slower rate. Each distinct request is measured once and
    // shared by everyone asking for it — a field is ground truth over the whole map, so unlike a
    // view frame there is nothing per-recipient about it, which is also exactly why it must never
    // be built for a recipient who did not ask.
    const fields = this.debugFields(matchId, state);
    // The rings, on the view frame's own cadence rather than the field's — they are read against
    // hulls that are moving (`protocol/debug.ts`). Measured once for the whole match, because
    // unlike a field there is not even a request to key them by: everybody watching gets the same
    // list of every transducer in the water.
    const runtime = this.store.runtime(matchId);
    const reach =
      state.debugMode && runtime?.anyDebugReach === true ? runtime.pingReach() : undefined;

    for (const player of state.players) {
      if (!player.connected) continue;
      const connection = this.connections.get(player.accountId);
      if (connection === undefined) continue;
      const frame = this.store.viewFor(matchId, player.accountId);
      if (frame === undefined) continue;
      connection.send(createMatchView(matchId, frame.seq, frame.view));
      const field = fields?.get(player.accountId);
      if (field != null) connection.send(createDebugField(matchId, state.clock.tick, field));
      if (reach !== undefined && runtime?.hasDebugReach(player.accountId) === true) {
        connection.send(createDebugReach(matchId, state.clock.tick, reach));
      }
    }
  }

  /**
   * The acoustic field owed to each watching account this tick, or `null` when none is due.
   *
   * Two guards before any arithmetic happens, and both matter: measuring a field walks every
   * lattice cell on the map and sweeps a fresh Dijkstra for the per-listener ones
   * (`MatchRuntime.fieldMap`), so a `debugMode` match where nobody has turned an overlay on —
   * which is most of them, since the lobby flag and the console command are separate — pays
   * nothing at all, and a tick that is not one of the slow ones pays nothing either.
   *
   * Requests are keyed so two developers watching the same field of the same boat measure it
   * once. A `null` answer for a request that cannot be met — a boat that has sunk, a field before
   * the first solve — is simply not sent, and the client takes its overlay down.
   */
  private debugFields(matchId: MatchId, state: MatchState): Map<AccountId, FieldMapView> | null {
    if (!state.debugMode || state.clock.tick % FIELD_TICKS !== 0) return null;
    const runtime = this.store.runtime(matchId);
    if (runtime === undefined) return null;

    const owed = new Map<AccountId, FieldMapView>();
    const measured = new Map<string, FieldMapView | null>();

    for (const player of state.players) {
      if (!player.connected) continue;
      const request = runtime.debugFieldOf(player.accountId);
      if (request === undefined) continue;

      const key = `${request.kind}:${String(request.boat ?? -1)}`;
      let map = measured.get(key);
      if (map === undefined) {
        map = runtime.fieldMap(request.kind, request.boat);
        measured.set(key, map);
      }
      if (map !== null) owed.set(player.accountId, map);
    }

    return owed.size === 0 ? null : owed;
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
  private setActiveSonar(connection: PlayerConnection, msg: MatchSetActiveSonarMessage): void {
    if (typeof msg.boat !== 'number' || !Number.isInteger(msg.boat)) return;
    if (typeof msg.active !== 'boolean') return;
    this.store.setActiveSonar(connection.accountId, msg.boat, msg.active);
  }

  // ── Debug console ─────────────────────────────────────────────────────────────

  /**
   * Throw the sender's own fog of war off or back on (`debug.setVision`).
   *
   * Refused outright on a match that was not started with `LobbySettings.debugMode` — the one
   * gate every command in this section shares, checked here rather than trusted from the
   * client, exactly like every other rule in this file.
   */
  private debugSetVision(connection: PlayerConnection, msg: DebugSetVisionMessage): void {
    const state = this.store.findByAccount(connection.accountId);
    if (state === undefined || !state.debugMode) return;
    if (typeof msg.enabled !== 'boolean') return;

    this.store.runtime(state.matchId)?.setDebugVision(connection.accountId, msg.enabled);
  }

  /**
   * Draw one acoustic field for this connection, or stop drawing any (`debug.setField`).
   *
   * Same `debugMode` gate as the two beside it, and nothing is sent back in answer: the overlay
   * appearing *is* the acknowledgement, and switching it off is confirmed by the payloads
   * stopping. A request on a match with no runtime — one that has already concluded — is a no-op,
   * like every other command here.
   *
   * The named boat is checked for *shape* and no further. Whether it exists, is afloat, or is on
   * the sender's side is settled where the field is measured, because all three can change between
   * the request and the next tick — and a debug player may ask about either fleet, which is the
   * whole point of a tool for balancing two of them against each other.
   */
  private debugSetField(connection: PlayerConnection, msg: DebugSetFieldMessage): void {
    const state = this.store.findByAccount(connection.accountId);
    if (state === undefined || !state.debugMode) return;
    if (msg.kind !== null && !isDebugFieldKind(msg.kind)) return;
    if (msg.boat !== null && !Number.isSafeInteger(msg.boat)) return;

    this.store.runtime(state.matchId)?.setDebugField(connection.accountId, msg.kind, msg.boat);
  }

  /**
   * Draw the ping-reach rings for this connection, or stop (`debug.setReach`).
   *
   * The same `debugMode` gate and the same silence as the two above: the rings arriving is the
   * acknowledgement, and switching them off is confirmed by them stopping.
   */
  private debugSetReach(connection: PlayerConnection, msg: DebugSetReachMessage): void {
    const state = this.store.findByAccount(connection.accountId);
    if (state === undefined || !state.debugMode) return;
    if (typeof msg.enabled !== 'boolean') return;

    this.store.runtime(state.matchId)?.setDebugReach(connection.accountId, msg.enabled);
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
    const state = this.store.findByAccount(connection.accountId);
    if (state === undefined || !state.debugMode) return;
    if (!isTeamId(msg.team)) return;
    if (!isVec2(msg.at) || !pointInExtents(msg.at, state.map.extents)) return;

    const runtime = this.store.runtime(state.matchId);
    if (runtime === undefined) return;

    if (msg.kind === 'sub') {
      if (!isHullId(msg.subtype)) return;
      runtime.spawnBoat(connection.accountId, msg.subtype, msg.team, msg.at);
      return;
    }
    if (msg.kind === 'torpedo') {
      if (!isWeaponId(msg.subtype) || !isDeployableWeapon(msg.subtype)) return;
      runtime.spawnTorpedo(connection.accountId, msg.subtype, msg.team, msg.at);
    }
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
   * The picture for one recipient: setup, a view frame, and the chat they can read. Sent
   * whether or not the match has concluded — `attach` follows it with `match.results` for a
   * finished one, since the setup is still what tells the results screen whose fleet is whose.
   *
   * The setup is projected from the state in hand rather than looked up again — the caller
   * already has the state, and a second lookup would introduce a "what if it is gone" branch
   * whose only honest handling is to send nothing at all.
   */
  private sendMatch(connection: PlayerConnection, state: MatchState): void {
    const godMode =
      this.store.runtime(state.matchId)?.hasDebugVision(connection.accountId) ?? false;
    connection.send(createMatchState(setupFor(state, connection.accountId, godMode)));

    const frame = this.store.viewFor(state.matchId, connection.accountId);
    if (frame !== undefined) {
      connection.send(createMatchView(state.matchId, frame.seq, frame.view));
    }

    for (const entry of this.store.chatFor(state.matchId, connection.accountId)) {
      connection.send(createChatMessage(entry));
    }
  }
}
