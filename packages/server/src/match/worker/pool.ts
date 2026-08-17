/**
 * @seg/server/match/worker/pool — how many matches this box will run, and what happens at the line.
 *
 * One worker thread per match, capped at `ServerConfig.maxConcurrentMatches` (default 32,
 * `SEG_MAX_MATCHES`). The cap is the only thing in the server that says no to a match, so it is
 * worth being explicit about what it is protecting against and what it is not.
 *
 * ## It is a thread cap, and threads are not free
 *
 * Each match brings its own V8 isolate, its own copy of the module graph, and — the part that
 * actually costs — its own acoustic solver, water lattice and terrain collider. Those last three
 * are per *match* rather than per thread, so moving them across a boundary duplicates nothing: a
 * box running 32 matches held 32 lattices before this change too. What is genuinely new is the
 * isolate overhead, which is why the cap is a small number rather than a large one.
 *
 * ## Refusal, not degradation
 *
 * At the cap `acquire` returns `null` and `lobby.start` is rejected with a message the host can
 * act on. That is the whole policy, and the alternative is worth naming so nobody re-litigates it
 * later: admitting the 33rd match would not fail the 33rd match, it would degrade the 32 already
 * running, and a player whose fight is stuttering has no idea why while the host who clicked start
 * gets exactly what they asked for. A refusal lands on the one person who can do something about
 * it, at the one moment they are looking.
 *
 * There is deliberately no queue. A queued start is a new client-facing concept — a position, a
 * cancel, a timeout, a roster that has gone stale by the time a slot opens — and none of that is
 * worth building before a deployment has been seen to hit the cap.
 *
 * ## The cap counts threads, not playable matches
 *
 * A finished match keeps its slot until it is removed, because its thread is still alive to answer
 * a player reconnecting to the results screen. `MatchStore` is what eventually calls `remove`.
 */

import type { MatchId, MatchState } from '@seg/shared';

import type { MatchRuntimeOptions } from '../runtime.js';
import { MatchHost, type MatchHostOptions } from './host.js';

export interface MatchPoolOptions {
  /** Hard ceiling on concurrent matches. `ServerConfig.maxConcurrentMatches`. */
  readonly limit: number;
  /** Passed to every `MatchRuntime` the pool builds. Tests use it to coarsen the lattice. */
  readonly runtimeOptions?: MatchRuntimeOptions;
  /** Milliseconds between ticks, or `null` for an unscheduled match a test steps by hand. */
  readonly intervalMs?: number | null;
}

/** What the pool needs from its owner to wire a host up. `state` comes from `acquire`. */
export type HostWiring = Omit<MatchHostOptions, 'state' | 'runtimeOptions' | 'intervalMs'>;

export class MatchPool {
  private readonly hosts = new Map<MatchId, MatchHost>();
  private readonly options: MatchPoolOptions;

  constructor(options: MatchPoolOptions) {
    this.options = options;
  }

  /** How many matches are on threads right now, finished-but-not-yet-removed included. */
  get size(): number {
    return this.hosts.size;
  }

  get limit(): number {
    return this.options.limit;
  }

  /** Whether a start would be refused right now. */
  get full(): boolean {
    return this.hosts.size >= this.options.limit;
  }

  /**
   * Spin a thread up for a deployed match, or refuse.
   *
   * `null` — rather than a throw — for the one refusal that is a normal operating condition and
   * not an error: a full server is working exactly as configured, and the caller's job is to say
   * so politely rather than to catch something. A worker that fails to *boot* does throw, because
   * that is a broken deployment and it should not be reported to a player as "try again shortly".
   */
  async acquire(state: MatchState, wiring: HostWiring): Promise<MatchHost | null> {
    if (this.full) return null;

    const host = new MatchHost({
      state,
      ...(this.options.runtimeOptions === undefined
        ? {}
        : { runtimeOptions: this.options.runtimeOptions }),
      ...(this.options.intervalMs === undefined ? {} : { intervalMs: this.options.intervalMs }),
      ...wiring,
    });
    // Registered before the await, so two starts racing through `full` cannot both find room. The
    // check above and this line are the whole of the mutual exclusion, and they work because
    // nothing yields between them.
    this.hosts.set(state.matchId, host);

    try {
      await host.started();
    } catch (error) {
      this.hosts.delete(state.matchId);
      await host.dispose();
      throw error;
    }
    return host;
  }

  get(matchId: MatchId): MatchHost | undefined {
    return this.hosts.get(matchId);
  }

  /** End a match's thread and free its slot. Safe to call for a match that is already gone. */
  async remove(matchId: MatchId): Promise<void> {
    const host = this.hosts.get(matchId);
    if (host === undefined) return;
    this.hosts.delete(matchId);
    await host.dispose();
  }

  /** End every thread. The shutdown path, and what a test uses to avoid leaking workers. */
  async close(): Promise<void> {
    const hosts = [...this.hosts.values()];
    this.hosts.clear();
    await Promise.all(hosts.map((host) => host.dispose()));
  }
}
