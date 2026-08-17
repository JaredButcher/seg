/**
 * @seg/server/match/publish — what everyone in a match is owed on a publish tick.
 *
 * This is `MatchHandler.publish` as it used to be, lifted out of both the places that now want it.
 * It emits `ServerMessage`s addressed to an account and knows nothing about how they travel:
 *
 * - **`match/worker/entry.ts`** encodes each one with the recipient's codec and posts the batch
 *   across the thread boundary. That is production.
 * - **`@seg/tools/bench-netcode`** counts the bytes and drops them, which is how the netcode
 *   benchmarks measure a publish without a socket (planning/17 §9).
 *
 * It lives here rather than inside the worker so those two cannot drift. The benchmarks exist to
 * report what publishing costs, and a benchmark that measured its own copy of the loop would keep
 * reporting a number for code the server had stopped running — which is the failure mode
 * `netcode-harness.test.ts` was written to catch, and this makes it structurally impossible
 * instead.
 *
 * ## It is not a pure read
 *
 * Building a frame advances two watermarks: the recipient's view sequence and their place in the
 * team's chart (`MatchRuntime.visionFor`). Calling this twice for one tick numbers two frames
 * differently and hands the second an empty chart slice. There is exactly one caller per publish,
 * and that is a rule rather than an accident.
 */

import {
  FIELD_MAP_HZ,
  SIM_TICK_HZ,
  createDebugField,
  createDebugReach,
  createDebugStats,
  createMatchView,
  teamFor,
  viewFor,
  type AccountId,
  type FieldMapView,
  type MatchState,
  type ServerMessage,
} from '@seg/shared';

import type { MatchRuntime } from './runtime.js';

/**
 * Sim ticks between acoustic-field sends, from the rate the payload itself declares.
 *
 * Derived here rather than in `match/field.ts` because the tick rate is the server's number and
 * that file is shared with the decoder. A field is read rather than reacted to, and it is two
 * orders of magnitude larger than a view frame, so it goes at the slowest rate that still animates.
 */
export const FIELD_TICKS = Math.max(1, Math.round(SIM_TICK_HZ / FIELD_MAP_HZ));

/** Where a publish's messages go. One call per message, addressed to one account. */
export type PublishSink = (accountId: AccountId, message: ServerMessage) => void;

/**
 * The per-recipient view sequence.
 *
 * Monotonic per connection (planning/02 §3.4), and owned by whoever is publishing — the worker
 * holds one per match, and a benchmark holds its own. A plain `Map` behind a name, so that the one
 * thing that must never be shared between two publishers is hard to share by accident.
 */
export class ViewSequencer {
  private readonly seqs = new Map<AccountId, number>();

  next(accountId: AccountId): number {
    const seq = (this.seqs.get(accountId) ?? 0) + 1;
    this.seqs.set(accountId, seq);
    return seq;
  }

  forget(accountId: AccountId): void {
    this.seqs.delete(accountId);
  }
}

/**
 * The acoustic field owed to each watching account this tick, or `null` when none is due.
 *
 * Two guards before any arithmetic happens, and both matter: measuring a field walks every lattice
 * cell on the map and sweeps a fresh Dijkstra for the per-listener ones (`MatchRuntime.fieldMap`),
 * so a `debugMode` match where nobody has turned an overlay on — which is most of them, since the
 * lobby flag and the console command are separate — pays nothing at all, and a tick that is not one
 * of the slow ones pays nothing either.
 *
 * Requests are keyed so two developers watching the same field of the same boat measure it once. A
 * `null` answer for a request that cannot be met — a boat that has sunk, a field before the first
 * solve — is simply not sent, and the client takes its overlay down.
 */
function debugFields(
  runtime: MatchRuntime,
  state: MatchState,
): Map<AccountId, FieldMapView> | null {
  if (!state.debugMode || state.clock.tick % FIELD_TICKS !== 0) return null;

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

/** One recipient's view frame, advancing their sequence and their chart watermark. */
export function frameFor(
  runtime: MatchRuntime,
  accountId: AccountId,
  seqs: ViewSequencer,
): ServerMessage {
  const state = runtime.state;
  const seq = seqs.next(accountId);
  const vision = runtime.visionFor(accountId, teamFor(state, accountId));
  const godMode = runtime.hasDebugVision(accountId);
  return createMatchView(state.matchId, seq, viewFor(state, accountId, vision, godMode));
}

/**
 * One view frame to everyone connected, plus whatever debug payloads they asked for.
 *
 * Built **per recipient** — a frame carries the chart *that connection* is still owed, and the
 * boats *that player* commands — so there is no shared object to emit and therefore no shared
 * object that could contain the other side's fleet (planning/01 §5).
 *
 * A player whose socket is down, or who has left, is skipped rather than queued. Their boats keep
 * their standing orders and their seat is held (planning/01 §7); what they miss is a picture that
 * was stale 100 ms later anyway, and attaching gives them a fresh one plus the whole chart. Gated
 * on `connected` as well as on having a connection: a deliberate leave holds the socket open, and
 * without this check a player sitting on the main menu would keep drawing frames for a HUD they
 * walked away from.
 */
export function publishMatch(runtime: MatchRuntime, seqs: ViewSequencer, emit: PublishSink): void {
  const state = runtime.state;

  // The debug overlays, at their own slower rate. Each distinct request is measured once and
  // shared by everyone asking for it — a field is ground truth over the whole map, so unlike a
  // view frame there is nothing per-recipient about it, which is also exactly why it must never
  // be built for a recipient who did not ask.
  const fields = debugFields(runtime, state);
  // The rings, on the view frame's own cadence rather than the field's — they are read against
  // hulls that are moving (`protocol/debug.ts`). Measured once for the whole match, because
  // unlike a field there is not even a request to key them by.
  const reach = state.debugMode && runtime.anyDebugReach ? runtime.pingReach() : undefined;

  // The one phase of the stopwatch that is not inside a tick. Started before the loop rather than
  // around each send, because what a reader wants to know is what a *publish* costs, not what one
  // player's share of it did.
  const stopwatch = runtime.stopwatch;
  const startedPublish = stopwatch.start();

  for (const player of state.players) {
    if (!player.connected) continue;
    const accountId = player.accountId;
    emit(accountId, frameFor(runtime, accountId, seqs));

    const field = fields?.get(accountId);
    if (field != null) emit(accountId, createDebugField(state.matchId, state.clock.tick, field));
    if (reach !== undefined && runtime.hasDebugReach(accountId)) {
      emit(accountId, createDebugReach(state.matchId, state.clock.tick, reach));
    }
  }
  stopwatch.record('publish', startedPublish);

  // The panel last, and outside the timed section on purpose: it reports the window that has just
  // closed, so measuring the reporting of it would fold this frame's own bookkeeping into the
  // figure a reader is about to read. Built once and shared, like the rings.
  if (!state.debugMode || !runtime.anyDebugStats) return;
  const stats = runtime.simStats();
  if (stats === null) return;
  for (const player of state.players) {
    if (!player.connected || !runtime.hasDebugStats(player.accountId)) continue;
    emit(player.accountId, createDebugStats(state.matchId, stats));
  }
}
