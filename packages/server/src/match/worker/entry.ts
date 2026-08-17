/**
 * @seg/server/match/worker/entry — one match, alone on a thread.
 *
 * Everything below this line used to be spread across three files on the main thread:
 * `match/clock.ts` drove the tick, `MatchStore.viewFor` numbered the frames, and
 * `MatchHandler.publish` decided who was owed what. They are together here because with one match
 * to a thread they are one loop, and splitting a loop across a postMessage would have been the
 * expensive way to keep a file boundary.
 *
 * ## What is different about the clock now
 *
 * `match/clock.ts` walked *every* running match through one `setInterval`, and its header explained
 * at length why forty timers would be worse than one. That reasoning was correct and no longer
 * applies: there is one match here, so there is one timer, and the drift it warned about is drift
 * between threads that no longer share a deadline. What survives unchanged is the part that
 * mattered most — **it does not catch up.** A thread that fell behind runs the next tick late
 * rather than running two back to back, because running two back to back makes an overload worse.
 *
 * planning/01 §4.3's rule ("a match host is driven by the scheduler and never self-schedules") is
 * still kept, in the only way it can be read once a match owns a thread: `MatchRuntime` is driven
 * by this file and still has no timer of its own, which is why every test can still call `tick()`
 * forty times in a row without sleeping.
 *
 * ## Errors
 *
 * A tick that throws is reported and skipped, never allowed to kill the interval — planning/01 §7's
 * "log, emit metric, continue". The blast radius is smaller than it was: a bad tick used to be one
 * match on a thread shared with every other, and is now one match on a thread of its own.
 */

import {
  BinaryCodec,
  JsonCodec,
  createMatchState,
  setupFor,
  type AccountId,
  type Codec,
  type CodecId,
  type MatchState,
  type ServerMessage,
} from '@seg/shared';
import { parentPort } from 'node:worker_threads';

import { frameFor, publishMatch, ViewSequencer } from '../publish.js';
import { MatchRuntime } from '../runtime.js';
import type {
  FromWorker,
  MatchCommand,
  MatchDigest,
  OutboundBundle,
  ToWorker,
} from './protocol.js';

if (parentPort === null) throw new Error('match worker started outside a worker thread');
const port = parentPort;

/**
 * One codec of each kind, shared by every recipient on this match.
 *
 * The gateway holds the same pair for the same reason (`realtime/gateway.ts`): both are stateless,
 * so a codec per connection would be an allocation for nothing. Which one a given account gets is
 * whatever it negotiated at the upgrade, forwarded here on `presence` — the worker encodes, so the
 * worker has to know.
 */
const codecs: Readonly<Record<CodecId, Codec>> = {
  json: new JsonCodec(),
  binary: new BinaryCodec(),
};

let runtime: MatchRuntime | null = null;
let timer: NodeJS.Timeout | null = null;
/** Set once, on the tick the match decided itself, so results are announced exactly once. */
let concluded = false;

const codecOf = new Map<AccountId, CodecId>();
/** Monotonic per recipient. A view sequence is per connection (planning/02 §3.4). */
const viewSeq = new ViewSequencer();

function post(message: FromWorker): void {
  port.postMessage(message);
}

// ── The digest the main thread routes against ─────────────────────────────────────────

function digestOf(state: MatchState): MatchDigest {
  return {
    matchId: state.matchId,
    mode: state.mode,
    phase: state.phase,
    debugMode: state.debugMode,
    extents: state.map.extents,
    players: state.players.map((player) => ({
      accountId: player.accountId,
      username: player.username,
      team: player.team,
      connected: player.connected,
    })),
  };
}

/**
 * Push a digest, but only when one of the few fields in it actually moved.
 *
 * The digest changes on a seat connecting, a seat leaving, and the phase going to `complete` —
 * three events in a half-hour match. Comparing before sending is what keeps this off the publish
 * path: without it, every tick would post a fresh copy of a structure nothing had touched.
 */
let lastDigest = '';
function pushDigest(state: MatchState): void {
  const digest = digestOf(state);
  const encoded = JSON.stringify(digest);
  if (encoded === lastDigest) return;
  lastDigest = encoded;
  post({ t: 'digest', digest });
}

// ── Encoding ──────────────────────────────────────────────────────────────────────────

/**
 * Collects what each recipient is owed this tick, encoded with the codec they negotiated.
 *
 * A builder rather than a list comprehension because a recipient can be owed up to four messages —
 * a view frame, an acoustic field, the ping-reach rings, the statistics panel — and they must
 * arrive on one `postMessage` rather than four. At sixteen players a publish is one hop across the
 * boundary, which is the cost this whole design is built to spend once.
 */
class Outbound {
  private readonly bundles = new Map<AccountId, Uint8Array[]>();

  add(accountId: AccountId, message: ServerMessage): void {
    const codec = codecs[codecOf.get(accountId) ?? 'json'];
    let payloads = this.bundles.get(accountId);
    if (payloads === undefined) {
      payloads = [];
      this.bundles.set(accountId, payloads);
    }
    payloads.push(codec.encode(message));
  }

  flush(): void {
    if (this.bundles.size === 0) return;
    const bundles: OutboundBundle[] = [];
    for (const [accountId, payloads] of this.bundles) bundles.push({ accountId, payloads });
    post({ t: 'out', bundles });
  }
}

// ── Publishing ────────────────────────────────────────────────────────────────────────

/**
 * One view frame to everyone connected, plus whatever debug payloads they asked for.
 *
 * The loop itself is `match/publish.ts`, shared with the netcode benchmarks so the two cannot
 * drift. All this adds is where the messages go: encoded with each recipient's own codec and
 * batched into a single `postMessage`.
 */
function publish(active: MatchRuntime): void {
  const out = new Outbound();
  publishMatch(active, viewSeq, (accountId, message) => {
    out.add(accountId, message);
  });
  out.flush();
}

/** Everything a connection is owed the moment it attaches or rejoins: setup, then a frame. */
function resend(active: MatchRuntime, accountId: AccountId): void {
  const state = active.state;
  const out = new Outbound();
  out.add(
    accountId,
    createMatchState(setupFor(state, accountId, active.hasDebugVision(accountId))),
  );
  out.add(accountId, frameFor(active, accountId, viewSeq));
  out.flush();
}

// ── The tick ──────────────────────────────────────────────────────────────────────────

function step(): void {
  const active = runtime;
  if (active === null) return;

  try {
    if (active.tick()) publish(active);
    // The frame goes first, deliberately: the last one carries both fleets' final positions and
    // `phase: 'complete'`, and a client that got the results before it would draw the outcome over
    // an ocean half a second out of date.
    if (!concluded && active.results !== null) {
      concluded = true;
      post({ t: 'results', results: active.results });
      pushDigest(active.state);
      // Nothing left to advance. The interval is dropped rather than left spinning on a runtime
      // that would refuse every call: the host keeps the thread alive because a player may still
      // reconnect to be handed the results, and a finished match should cost that and no more.
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
  } catch (error) {
    post({ t: 'tickError', message: error instanceof Error ? error.message : String(error) });
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────────────

/**
 * Apply one command.
 *
 * Every branch is a straight forward to `MatchRuntime`, which owns every rule that needs the fleet
 * in hand — ownership, whether a tube is loaded, whether this hull may hold that load. Nothing is
 * re-checked here: a second copy of a rule is how the two copies come to disagree, and the handler
 * on the far side has already refused everything that is not *shaped* like a command.
 */
function apply(active: MatchRuntime, accountId: AccountId, cmd: MatchCommand): void {
  switch (cmd.t) {
    case 'order':
      active.order(accountId, cmd.boat, cmd.to, cmd.queue);
      return;
    case 'cancel':
      active.cancel(accountId, cmd.boat);
      return;
    case 'throttle':
      active.setThrottle(accountId, cmd.boat, cmd.notch);
      return;
    case 'sonar':
      active.setActiveSonar(accountId, cmd.boat, cmd.active);
      return;
    case 'fire':
      active.fire(accountId, cmd.boat, cmd.tubes, cmd.to);
      return;
    case 'drop':
      active.drop(accountId, cmd.boat);
      return;
    case 'load':
      active.load(accountId, cmd.boat, cmd.tube, cmd.weapon, cmd.swap);
      return;
    case 'debug.vision':
      active.setDebugVision(accountId, cmd.enabled);
      return;
    case 'debug.field':
      active.setDebugField(accountId, cmd.kind, cmd.boat);
      return;
    case 'debug.reach':
      active.setDebugReach(accountId, cmd.enabled);
      return;
    case 'debug.stats':
      active.setDebugStats(accountId, cmd.enabled);
      return;
    case 'debug.spawn':
      if (cmd.kind === 'sub') active.spawnBoat(accountId, cmd.subtype, cmd.team, cmd.at);
      else active.spawnTorpedo(accountId, cmd.subtype, cmd.team, cmd.at);
      return;
  }
}

/** Mark a seat connected or not. Their boats keep their orders either way (planning/04 §5). */
function setConnected(active: MatchRuntime, accountId: AccountId, connected: boolean): void {
  const state = active.state;
  const players = state.players.map((player) =>
    player.accountId === accountId ? { ...player, connected } : player,
  );
  active.replace({ ...state, players });
  pushDigest(active.state);
}

// ── The port ──────────────────────────────────────────────────────────────────────────

port.on('message', (message: ToWorker) => {
  if (message.t === 'init') {
    const { state, options, intervalMs } = message.init;
    runtime = new MatchRuntime(state, options);
    lastDigest = JSON.stringify(digestOf(state));
    post({ t: 'ready', digest: digestOf(state) });
    if (intervalMs !== null) timer = setInterval(step, intervalMs);
    return;
  }

  const active = runtime;
  if (active === null) return;

  switch (message.t) {
    case 'presence':
      if (message.codec !== null) codecOf.set(message.accountId, message.codec);
      setConnected(active, message.accountId, message.connected);
      return;
    case 'forget':
      active.forget(message.accountId);
      return;
    case 'resend':
      resend(active, message.accountId);
      return;
    case 'command':
      apply(active, message.accountId, message.cmd);
      return;
    case 'probe':
      post({
        t: 'probe',
        id: message.id,
        reading: active.probe(message.boat, message.at) ?? null,
        tick: active.state.clock.tick,
      });
      return;
    case 'step':
      step();
      return;
    case 'sync':
      post({ t: 'synced', id: message.id });
      return;
    case 'stop':
      if (timer !== null) clearInterval(timer);
      timer = null;
      runtime = null;
      port.close();
      return;
  }
});
