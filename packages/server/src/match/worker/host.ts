/**
 * @seg/server/match/worker/host — the main thread's handle on one match's thread.
 *
 * The seam planning/12 Q30 promised: "single process for 1.0, the `MatchHost` seam makes it a later
 * swap". This is the swap. Above it, nothing knows a thread exists — `MatchStore` asks a host to
 * apply a command and a host posts a message. Below it, nothing knows a socket exists — the worker
 * hands back bytes addressed to an account and this file finds the connection.
 *
 * ## It owns the thread, not the match
 *
 * A host is a pipe with a lifetime. It does not hold `MatchState`, it does not decide when a match
 * ends, and it does not know what a lobby is. What it holds is the `Worker`, the digest the worker
 * last pushed, and the two callbacks that carry results and outbound bytes back to whatever
 * composed it. That is deliberately the same division `MatchStore`'s header draws for itself, one
 * level down.
 *
 * ## Failure
 *
 * A worker can die in ways an in-process runtime could not: an uncaught throw outside a tick, an
 * OOM, a `terminate` that raced a message. All of them arrive as `error` or `exit`, and all of them
 * mean the same thing to the match — it is over and it cannot be recovered, because the only copy
 * of its state was in that isolate. `onLost` is how that is reported; the store turns it into a
 * concluded match so the players are told something true rather than left on a HUD that stopped
 * updating. This is the one genuinely new failure mode the thread boundary introduces, and it is
 * worth keeping in view: **the state has no second copy.**
 */

import { Worker } from 'node:worker_threads';

import { SIM_TICK_HZ } from '@seg/shared';
import type {
  AccountId,
  CodecId,
  EntityId,
  MatchId,
  MatchResults,
  MatchState,
  ProbeReading,
  Vec2,
} from '@seg/shared';

import type { MatchRuntimeOptions } from '../runtime.js';
import type {
  FromWorker,
  MatchCommand,
  MatchDigest,
  OutboundBundle,
  ToWorker,
} from './protocol.js';

/** Where the worker's entry point is. `.mjs` on purpose — see `boot.mjs`. */
const BOOT_URL = new URL('./boot.mjs', import.meta.url);

export interface MatchHostOptions {
  readonly state: MatchState;
  readonly runtimeOptions?: MatchRuntimeOptions;
  /**
   * Milliseconds between ticks, or `null` to leave the match unscheduled and drive it by hand.
   *
   * `null` is a test's option and the reason `step()` exists. Production leaves it undefined and
   * gets the simulation rate.
   */
  readonly intervalMs?: number | null;
  /** Encoded payloads for one account, ready for a socket. */
  readonly onOutbound: (bundles: readonly OutboundBundle[]) => void;
  /** The match decided itself. Fired once. */
  readonly onResults: (results: MatchResults) => void;
  /** A field the main thread routes against moved: presence, or the phase. */
  readonly onDigest: (digest: MatchDigest) => void;
  /** The thread died. The match is unrecoverable — see the header. */
  readonly onLost: (reason: string) => void;
  /** A tick threw but the match survived it. */
  readonly onTickError?: (message: string) => void;
}

export class MatchHost {
  readonly matchId: MatchId;

  private readonly worker: Worker;
  private readonly options: MatchHostOptions;
  private digestValue: MatchDigest;
  /** Outstanding `debug.probe` questions, by the id they were asked under. */
  private readonly probes = new Map<number, (reading: ProbeReading | null, tick: number) => void>();
  /** Outstanding `sync` tokens. Shares `nextProbeId`, because both are just round-trip ids. */
  private readonly syncs = new Map<number, () => void>();
  private nextProbeId = 1;
  private ready: Promise<void>;
  private stopped = false;

  constructor(options: MatchHostOptions) {
    this.options = options;
    this.matchId = options.state.matchId;
    this.digestValue = emptyDigest(options.state);

    this.worker = new Worker(BOOT_URL);
    this.worker.on('message', (message: FromWorker) => {
      this.receive(message);
    });
    this.worker.on('error', (error: Error) => {
      this.lost(error.message);
    });
    this.worker.on('exit', (code) => {
      // A clean exit after `stop()` is the expected end of every match and is not a loss.
      if (this.stopped) return;
      this.lost(`match worker exited with code ${String(code)}`);
    });

    // Settled by whichever comes first. Rejecting on a boot failure rather than waiting forever is
    // load-bearing: `MatchStarter` awaits this, and a worker that cannot load its entry point would
    // otherwise leave `lobby.start` hanging with the lobby stuck on "starting" and a slot held
    // against the cap for the life of the process.
    this.ready = new Promise<void>((resolve, reject) => {
      const onMessage = (message: FromWorker): void => {
        if (message.t !== 'ready') return;
        done();
        resolve();
      };
      const onFailure = (error: Error): void => {
        done();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const done = (): void => {
        this.worker.off('message', onMessage);
        this.worker.off('error', onFailure);
      };
      this.worker.on('message', onMessage);
      this.worker.on('error', onFailure);
    });

    this.send({
      t: 'init',
      init: {
        state: options.state,
        options: options.runtimeOptions ?? {},
        intervalMs: options.intervalMs === undefined ? 1000 / SIM_TICK_HZ : options.intervalMs,
      },
    });
  }

  /** Resolves once the runtime is built and the first tick is armed. */
  started(): Promise<void> {
    return this.ready;
  }

  /** What the main thread is allowed to know about this match (`protocol.ts`). */
  get digest(): MatchDigest {
    return this.digestValue;
  }

  // ── Sending ─────────────────────────────────────────────────────────────────────────

  private send(message: ToWorker): void {
    if (this.stopped) return;
    this.worker.postMessage(message);
  }

  /**
   * A seat's socket came or went, with the codec it negotiated.
   *
   * The codec travels with presence rather than on its own message because the two are learned at
   * the same instant — the gateway settles the codec at the upgrade, before a byte is encoded —
   * and because there is no moment where the worker needs one without the other.
   */
  presence(accountId: AccountId, connected: boolean, codec: CodecId | null): void {
    this.send({ t: 'presence', accountId, connected, codec });
  }

  /** Start this account's chart from nothing: a reconnecting client is a fresh tab. */
  forget(accountId: AccountId): void {
    this.send({ t: 'forget', accountId });
  }

  /** Send this account its setup and a view frame now, rather than on the next publish tick. */
  resend(accountId: AccountId): void {
    this.send({ t: 'resend', accountId });
  }

  /** Apply a command. Fire-and-forget, like every command in the match protocol but one. */
  command(accountId: AccountId, cmd: MatchCommand): void {
    this.send({ t: 'command', accountId, cmd });
  }

  /**
   * The one question (`debug.probe`).
   *
   * Never rejects and never hangs on a dead worker: a probe that cannot be answered resolves to
   * `null`, which is what the panel already treats as "keep the last reading". A rejection here
   * would have to be caught at a call site whose only sane handling is to do nothing.
   */
  probe(boat: EntityId | null, at: Vec2): Promise<{ reading: ProbeReading | null; tick: number }> {
    if (this.stopped) return Promise.resolve({ reading: null, tick: 0 });
    const id = this.nextProbeId++;
    return new Promise((resolve) => {
      this.probes.set(id, (reading, tick) => {
        resolve({ reading, tick });
      });
      this.send({ t: 'probe', id, boat, at });
    });
  }

  /** Advance one tick by hand. Only meaningful when the host was built with `intervalMs: null`. */
  step(): void {
    this.send({ t: 'step' });
  }

  /**
   * Resolve once the worker has handled everything posted before this call.
   *
   * A test's tool, and the reason the match tests are not timing-dependent (`protocol.ts#sync`).
   * Resolves immediately for a stopped worker rather than hanging, so a teardown that syncs after
   * disposing does not wedge the suite.
   */
  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const id = this.nextProbeId++;
    return new Promise((resolve) => {
      this.syncs.set(id, resolve);
      this.send({ t: 'sync', id });
    });
  }

  // ── Receiving ───────────────────────────────────────────────────────────────────────

  private receive(message: FromWorker): void {
    switch (message.t) {
      case 'ready':
      case 'digest':
        this.digestValue = message.digest;
        if (message.t === 'digest') this.options.onDigest(message.digest);
        return;
      case 'out':
        this.options.onOutbound(message.bundles);
        return;
      case 'results':
        this.options.onResults(message.results);
        return;
      case 'probe': {
        const waiting = this.probes.get(message.id);
        if (waiting === undefined) return;
        this.probes.delete(message.id);
        waiting(message.reading, message.tick);
        return;
      }
      case 'tickError':
        this.options.onTickError?.(message.message);
        return;
      case 'synced': {
        const waiting = this.syncs.get(message.id);
        if (waiting === undefined) return;
        this.syncs.delete(message.id);
        waiting();
        return;
      }
    }
  }

  private lost(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    // Everything waiting on the thread is released rather than left pending: a dead worker will
    // never answer, and a hung promise is how a lost match becomes a hung request.
    for (const waiting of this.probes.values()) waiting(null, 0);
    this.probes.clear();
    for (const waiting of this.syncs.values()) waiting();
    this.syncs.clear();
    this.options.onLost(reason);
  }

  /**
   * End the thread.
   *
   * `stop` first so the worker drops its interval and closes its port on its own terms, then
   * `terminate` regardless. The terminate is not a belt-and-braces flourish: a worker wedged in a
   * tick will never read the message, and a match that will not go away is a leaked thread against
   * a cap of 32.
   */
  async dispose(): Promise<void> {
    if (this.stopped) {
      await this.worker.terminate();
      return;
    }
    this.stopped = true;
    // Anything still waiting on an answer is released before the thread goes, for the reason
    // `lost` gives: a terminated worker answers nothing, and a pending promise outlives it.
    for (const waiting of this.probes.values()) waiting(null, 0);
    this.probes.clear();
    for (const waiting of this.syncs.values()) waiting();
    this.syncs.clear();
    this.worker.postMessage({ t: 'stop' } satisfies ToWorker);
    await this.worker.terminate();
  }
}

/**
 * The digest before the worker has pushed one.
 *
 * Built from the state the host was handed rather than left undefined, so a command arriving in the
 * gap between construction and `ready` routes against the truth instead of finding nothing. The
 * worker overwrites it with an identical one a moment later.
 */
function emptyDigest(state: MatchState): MatchDigest {
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
