/**
 * @seg/server/match/worker/protocol — what crosses the thread boundary, and what does not.
 *
 * One match, one worker thread (planning/01 §1 scaling step 1, planning/17 §6.3 B). The whole
 * simulation lives on the far side of this file: `MatchRuntime`, the acoustic solver, the water
 * lattice, both teams' pictures, every per-recipient chart watermark. What comes back is bytes.
 *
 * ## The two rules this shape is built on
 *
 * **Nothing that is asked for is answered synchronously, and almost nothing is asked for.** Every
 * command the handler used to route — `fire`, `drop`, `load`, `setActiveSonar`, `order`, `cancel`,
 * `throttle` — already discarded its return value before any of this existed: the receipt for a
 * shot is the tube going into reload on the next view frame, not a reply (`match/handler.ts`). So
 * they cross as fire-and-forget posts and nothing waits. `debug.probe` is the single exception in
 * the entire match protocol, because it is the one command that is a *question*, and it is the
 * only member of `WorkerRequest`.
 *
 * **The worker encodes.** A `MatchViewState` handed back as an object would be structured-cloned
 * on the way out and again on the way in — two copies of a graph that planning/17 §2.1 measured
 * `JSON.stringify` over at 0.151 ms for `worst`, paid on both threads, to save an encode the
 * server was going to do anyway. Instead the worker holds both codecs, is told which one each
 * recipient negotiated (`realtime/gateway.ts`), and posts finished bytes. The main thread's whole
 * job on the outbound path becomes a map lookup and a socket write.
 *
 * A corollary worth naming: **the per-recipient view sequence and the chart watermark live in the
 * worker**, because that is where frames are built, and `MatchStore.viewFor`'s "not a pure read"
 * warning is exactly as true here as it was there.
 *
 * ## What the main thread keeps
 *
 * `MatchDigest` — the small, slow-moving facts the handler validates and routes against. It is
 * pushed on change rather than polled, and it is deliberately *not* a copy of `MatchState`: no
 * boats, no torpedoes, no map. A digest that carried the fleet would be the enemy fleet sitting on
 * the wrong side of the boundary that exists to keep it away (planning/01 §5), and it would have to
 * be re-sent 10 times a second to stay true.
 *
 * Ownership of a boat is therefore **not** checkable on the main thread any more. That check moves
 * to `MatchRuntime`, next to the boats, which is where `fire`/`drop`/`load`/`setActiveSonar` had
 * always kept theirs and where this file's header would have argued it belonged all along.
 */

import type {
  AccountId,
  CodecId,
  DebugFieldKind,
  EntityId,
  GameMode,
  HullId,
  MapExtents,
  MatchId,
  MatchPhase,
  MatchResults,
  MatchState,
  ProbeReading,
  TeamId,
  ThrottleNotch,
  Vec2,
  WeaponId,
} from '@seg/shared';

import type { MatchRuntimeOptions } from '../runtime.js';

// ── The main thread's view of a match ─────────────────────────────────────────────────

/**
 * One seat, as the main thread needs to know it.
 *
 * `MatchPlayer` exactly (`shared/match/state.ts`), and re-declared rather than imported so that
 * widening the seat does not silently widen what crosses the boundary. A spectator is `team: null`
 * — there is no separate position field on a match player, only on the deploying one.
 */
export interface DigestPlayer {
  readonly accountId: AccountId;
  readonly username: string;
  readonly team: TeamId | null;
  readonly connected: boolean;
}

/**
 * Everything the main thread is allowed to know about a running match.
 *
 * Sized by what `MatchHandler` actually reads: the debug gate, the map bounds an aim point is
 * checked against, who is seated where, and the tick a debug payload is stamped with. Nothing
 * else — see the header on why this is not a `MatchState` mirror.
 */
export interface MatchDigest {
  readonly matchId: MatchId;
  readonly mode: GameMode;
  readonly phase: MatchPhase;
  readonly debugMode: boolean;
  /** What an ordered point or an aim point is checked against (`pointInExtents`). */
  readonly extents: MapExtents;
  readonly players: readonly DigestPlayer[];
}

/** The team an account is on, from the digest — `teamFor` without a `MatchState` to hand. */
export function teamOf(digest: MatchDigest, accountId: AccountId): TeamId | null {
  return digest.players.find((player) => player.accountId === accountId)?.team ?? null;
}

// ── Commands: main thread → worker ────────────────────────────────────────────────────

/**
 * A command, shape-checked by the handler and rule-checked by the runtime.
 *
 * The split is the same one the codebase already draws and is worth restating because the thread
 * boundary makes it look new: the handler refuses what is not *shaped* like a command (a boat id
 * that is not an integer, an aim point off the map, a salvo naming two hundred tubes), and the
 * runtime refuses what is not *allowed* (a boat this account does not command, a tube that is
 * reloading, a load this hull never fitted). Only the first of those can be done without the
 * fleet in hand, which is precisely why only the first stayed behind.
 */
export type MatchCommand =
  | { readonly t: 'order'; readonly boat: EntityId; readonly to: Vec2; readonly queue: boolean }
  | { readonly t: 'cancel'; readonly boat: EntityId }
  | { readonly t: 'throttle'; readonly boat: EntityId; readonly notch: ThrottleNotch }
  | { readonly t: 'sonar'; readonly boat: EntityId; readonly active: boolean }
  | {
      readonly t: 'fire';
      readonly boat: EntityId;
      readonly tubes: readonly number[];
      readonly to: Vec2;
    }
  | { readonly t: 'drop'; readonly boat: EntityId }
  | {
      readonly t: 'load';
      readonly boat: EntityId;
      readonly tube: number;
      readonly weapon: WeaponId;
      readonly swap: boolean;
    }
  | { readonly t: 'debug.vision'; readonly enabled: boolean }
  | {
      readonly t: 'debug.field';
      readonly kind: DebugFieldKind | null;
      readonly boat: EntityId | null;
    }
  | { readonly t: 'debug.reach'; readonly enabled: boolean }
  | { readonly t: 'debug.stats'; readonly enabled: boolean }
  /**
   * Split by `kind` rather than carrying a `HullId | WeaponId`, so the worker can hand the subtype
   * straight to `spawnBoat`/`spawnTorpedo` without a cast. The handler has already checked it is a
   * real hull, or a real *deployable* weapon — the same rule the tube picker enforces.
   */
  | {
      readonly t: 'debug.spawn';
      readonly kind: 'sub';
      readonly subtype: HullId;
      readonly team: TeamId;
      readonly at: Vec2;
    }
  | {
      readonly t: 'debug.spawn';
      readonly kind: 'torpedo';
      readonly subtype: WeaponId;
      readonly team: TeamId;
      readonly at: Vec2;
    };

/**
 * The worker's first message, carrying the deployed match.
 *
 * `MatchState` structured-clones once, at start, and it is the one genuinely large thing that
 * crosses: `map` holds the generated terrain. That is the right place to pay it — the alternative
 * is generating the map twice and hoping two runs of a seeded generator agree, which is a
 * determinism claim nobody should have to make (`shared/map`).
 */
export interface WorkerInit {
  readonly state: MatchState;
  readonly options: MatchRuntimeOptions;
  /** Milliseconds between ticks. Defaults to the sim rate; a test drives it by hand with `null`. */
  readonly intervalMs: number | null;
}

export type ToWorker =
  | { readonly t: 'init'; readonly init: WorkerInit }
  /**
   * A seat's socket came or went (`MatchHandler.attach`/`detach`/`departed`/`rejoin`).
   *
   * The worker needs this for two reasons that are easy to conflate: `publish` skips a seat with
   * nobody behind it, and — the load-bearing one — `decideAbandonment` reads exactly these flags
   * to end a match nobody is left in. A worker told nothing about presence would run an empty
   * match for the full half hour.
   */
  | {
      readonly t: 'presence';
      readonly accountId: AccountId;
      readonly connected: boolean;
      /**
       * What this connection negotiated, or `null` when there is no connection to speak of.
       *
       * `null` on every disconnect, and the worker leaves the remembered codec alone rather than
       * overwriting it: a departure carries no codec because there is no socket, and defaulting one
       * in would mean a player who dropped and came back on `binary` had a moment where their
       * frames were built as JSON.
       */
      readonly codec: CodecId | null;
    }
  /** Start this account's chart from nothing: a reconnecting client is a fresh tab. */
  | { readonly t: 'forget'; readonly accountId: AccountId }
  /** Send this account its setup and a view frame now, rather than on the next publish tick. */
  | { readonly t: 'resend'; readonly accountId: AccountId }
  | { readonly t: 'command'; readonly accountId: AccountId; readonly cmd: MatchCommand }
  /**
   * No `accountId`: a probe is a question about the water, and `MatchRuntime.probe` takes a boat
   * to listen from and a point to listen at. Which developer clicked is the *host's* bookkeeping,
   * kept against `id` so the answer finds its way back to the right socket.
   */
  | {
      readonly t: 'probe';
      readonly id: number;
      readonly boat: EntityId | null;
      readonly at: Vec2;
    }
  /** Advance one tick by hand. Only a test sends this, and only with `intervalMs: null`. */
  | { readonly t: 'step' }
  /**
   * Round-trip a token, so a caller can know the worker has caught up.
   *
   * Exists for tests, and it is not a convenience — it is what makes them deterministic. Everything
   * else on this channel is fire-and-forget, so a test that posts four `step`s has no way to know
   * when the frames they produced have landed; waiting on timers instead means racing thread
   * scheduling, which fails a few percent of the time on a loaded machine and is exactly the sort
   * of flake nobody ever gets round to fixing.
   *
   * A port delivers messages in order, so an answer to this proves every message posted before it
   * was handled and every reply they produced was already sent.
   */
  | { readonly t: 'sync'; readonly id: number }
  | { readonly t: 'stop' };

// ── Results: worker → main thread ─────────────────────────────────────────────────────

/**
 * One recipient's share of a publish, already encoded with the codec they negotiated.
 *
 * Several messages may be owed to one account on one tick — a view frame, an acoustic field, the
 * ping-reach rings, the statistics panel — so this is a list of payloads rather than one, and the
 * whole publish crosses as a **single** `postMessage` rather than one per recipient. At sixteen
 * players that is one hop instead of sixteen, and the hop is the cost this design is spending.
 */
export interface OutboundBundle {
  readonly accountId: AccountId;
  readonly payloads: readonly Uint8Array[];
}

export type FromWorker =
  /** The runtime is built and the first tick is armed. The host resolves its `start` on this. */
  | { readonly t: 'ready'; readonly digest: MatchDigest }
  | { readonly t: 'out'; readonly bundles: readonly OutboundBundle[] }
  /** Pushed when a field the main thread routes against moved — presence, phase, the tick. */
  | { readonly t: 'digest'; readonly digest: MatchDigest }
  /**
   * The match decided itself.
   *
   * The object rather than bytes, unlike everything else on this channel, because the main thread
   * genuinely reads it: `resultsFor` answers a player reconnecting into a finished match, and the
   * fan-out is addressed from `results.players`. It happens once.
   */
  | { readonly t: 'results'; readonly results: MatchResults }
  /**
   * The answer to the one question in the match protocol.
   *
   * Carries the tick it was measured on, which is the only reason the digest does not: stamping a
   * debug payload was the last thing the main thread wanted a clock for, and pushing a digest ten
   * times a second to keep a counter fresh would have been a postMessage per publish for a number
   * nothing routes on.
   */
  | {
      readonly t: 'probe';
      readonly id: number;
      readonly reading: ProbeReading | null;
      readonly tick: number;
    }
  /** A tick threw. Logged and counted by the host; the match keeps running (planning/01 §7). */
  | { readonly t: 'tickError'; readonly message: string }
  /** The answer to `sync` — see there for why it exists. */
  | { readonly t: 'synced'; readonly id: number };
