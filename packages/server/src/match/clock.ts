/**
 * @seg/server/match/clock — the thing that calls `tick()`.
 *
 * One timer for the whole process, walking every running match. Not a timer per match: at the
 * concurrency 1.0 targets, forty separate intervals would drift against each other for no
 * benefit, and a single loop is also the only place a "this tick overran" measurement can
 * honestly be taken (planning/01 §1, tick budget).
 *
 * It is deliberately the *only* thing in the server that knows what a millisecond is. The
 * runtime counts ticks, the view frames count ticks, and every test drives `tick()` by hand —
 * so nothing below this file has to be tested against a clock (planning/13 §13).
 */

import { SIM_TICK_HZ } from '@seg/shared';

import type { MatchHandler } from './handler.js';
import type { MatchStore } from './store.js';

export interface MatchClockOptions {
  readonly store: MatchStore;
  readonly matches: MatchHandler;
  /** Milliseconds between ticks. Defaults to the simulation rate (planning/04 §1). */
  readonly intervalMs?: number;
  /** Where an overrun is reported. Injected so a test can assert on it without a console. */
  readonly onError?: (matchId: string, error: unknown) => void;
}

export interface MatchClock {
  /** Advance every running match by one tick, publishing frames where one came due. */
  step(): void;
  stop(): void;
}

/**
 * Drive every running match at the simulation rate.
 *
 * A tick that throws is logged and skipped rather than allowed to kill the interval: one match
 * with a bad state must not stop every other match on the process. planning/01 §7 asks for
 * "log, emit metric, continue" and this is the continue.
 *
 * Note what it does **not** do: catch up. A process that fell behind runs the next tick late
 * rather than running two back to back, because running two back to back makes an overload
 * worse rather than better.
 */
export function startMatchClock(options: MatchClockOptions): MatchClock {
  const { store, matches } = options;
  const intervalMs = options.intervalMs ?? 1000 / SIM_TICK_HZ;
  const onError =
    options.onError ??
    ((matchId, error) => {
      console.error('[seg] match tick failed', matchId, error);
    });

  function step(): void {
    for (const { matchId, runtime } of store.running()) {
      try {
        if (runtime.tick()) matches.publish(matchId);
      } catch (error) {
        onError(matchId, error);
      }
    }
  }

  const timer = setInterval(step, intervalMs);
  // Never keep the process alive on its own account: a server with no matches should still be
  // able to shut down, and a test that forgot to stop the clock should still exit.
  timer.unref();

  return {
    step,
    stop: () => {
      clearInterval(timer);
    },
  };
}
