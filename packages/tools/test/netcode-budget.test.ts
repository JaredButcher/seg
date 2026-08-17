/**
 * The bandwidth ratchet: what the netcode puts on the wire, pinned to the byte.
 *
 * This is the suite planning/17 §9 exists to justify, and the reason it can exist at all is that
 * **bytes are exact.** Every timing in this repo is worth ±20% on an unpinned box and is not
 * comparable across sessions (planning/16 §6), so a performance test can only ever assert a
 * relative regression. A byte count for a fixed scenario and seed is the same number on any
 * machine, this year and next — so it can be written down, and a change that moves it has changed
 * the protocol whether or not it meant to.
 *
 * ## How to use this when a change fails it
 *
 * A failure here is **not** a bug report. It is the measurement, delivered. The failure message
 * says what moved and by how much; read it, decide whether that was the intent, and update the
 * baseline in the same commit. A netcode change that does not move a number here did nothing.
 *
 * ## What it deliberately does not do
 *
 * It does not assert planning/02 §6's 8 KB/s budget, because **the budget is not met** — the
 * measured figures below are 1.9× over it at two boats and 31× over at the supported maximum, and
 * a test that fails on every run teaches people to ignore the suite. What it asserts instead is a
 * **ratchet**: the gap may close, and it may not widen. The day the levers in planning/17 §5 land,
 * `staysWithin` starts passing and this comment comes out.
 *
 * ## Why the match id is fixed
 *
 * `matchId` travels in every `match.view` (`createMatchView`), so a longer id is a bigger frame.
 * The baselines below were taken with `'budget'` and they move by one byte per frame per character
 * if that changes. It is the smallest possible illustration of the point this suite is making.
 */

import { describe, expect, it } from 'vitest';

import {
  NetBench,
  percentile,
  scenario,
  type NetBenchOptions,
} from '../src/bench-netcode/scenario.js';

/** planning/02 §6. Downstream, per player, at p95, in the worst realistic case. */
const BUDGET_BYTES_PER_SEC = 8 * 1024;
/** planning/02 §5: one view frame per acoustic solve, on every second sim tick. */
const FRAMES_PER_SEC = 10;

/** The id every scenario runs under — see this file's header. */
const MATCH_ID = 'budget';

interface Baseline {
  /** Boats deployed. A guard on the fixture rather than on the netcode. */
  readonly boats: number;
  readonly recipients: number;
  readonly publishes: number;
  /** Every byte every recipient was sent, over the measured window. Exact. */
  readonly totalBytes: number;
  /** Encoded size of one `match.view`. Exact. */
  readonly p50: number;
  readonly p95: number;
}

/**
 * The scenarios, and what they measured on 2026-08-17.
 *
 * `worst` is slow — 160 boats through six warm-up ticks and five publishes — and it is kept
 * anyway, at a reduced tick count, because it is the case planning/02 §6's budget is actually
 * written against and the only one that exercises a full 16-player lobby.
 */
const CASES: Readonly<Record<string, { options: NetBenchOptions; baseline: Baseline }>> = {
  /** The floor: two boats creeping across open water. Nothing is happening and it still costs. */
  quiet: {
    options: scenario('quiet', { warmup: 10, ticks: 20 }),
    baseline: { boats: 2, recipients: 2, publishes: 10, totalBytes: 30_934, p50: 1546, p95: 1549 },
  },
  /** 2v2, two boats each, cavitating on a small dense map — a real picture without a big fleet. */
  duel: {
    options: scenario('typical', {
      players: 4,
      boats: 2,
      mapSize: 'small',
      throttle: 'flank',
      warmup: 10,
      ticks: 20,
    }),
    baseline: { boats: 8, recipients: 4, publishes: 10, totalBytes: 114_626, p50: 2846, p95: 3023 },
  },
  /** The design target: 3v3, four boats each (planning/05 §6). */
  typical: {
    options: scenario('typical', { warmup: 10, ticks: 20 }),
    baseline: {
      boats: 24,
      recipients: 6,
      publishes: 10,
      totalBytes: 322_440,
      p50: 5382,
      p95: 5425,
    },
  },
  /** The supported maximum: 8v8 × 10 boats + 4 spectators, dense/large, everybody at flank. */
  worst: {
    options: scenario('worst', { warmup: 6, ticks: 10 }),
    baseline: {
      boats: 160,
      recipients: 20,
      publishes: 5,
      totalBytes: 2_023_732,
      p50: 24_846,
      p95: 25_847,
    },
  },
};

interface Measured extends Baseline {
  readonly frameSizes: readonly number[];
}

function measure(options: NetBenchOptions): Measured {
  const bench = new NetBench(options, MATCH_ID);
  bench.warmUp();

  let publishes = 0;
  for (let tick = 0; tick < options.ticks; tick += 1) {
    if (!bench.tick()) continue;
    bench.publish();
    publishes += 1;
  }

  const frameSizes = bench.recipients.flatMap((connection) => connection.frameSizes);
  return {
    boats: bench.state.boats.length,
    recipients: bench.recipients.length,
    publishes,
    totalBytes: bench.bytes,
    p50: percentile(frameSizes, 50),
    p95: percentile(frameSizes, 95),
    frameSizes,
  };
}

/** `+4.2%`, or `—` when nothing moved. What a failure message is actually for. */
function drift(measured: number, baseline: number): string {
  if (measured === baseline) return '—';
  const percent = ((measured - baseline) / baseline) * 100;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(2)}% (${measured - baseline > 0 ? '+' : ''}${measured - baseline} bytes)`;
}

/**
 * One measurement per scenario, memoized and taken **lazily**.
 *
 * Lazily because `worst` deploys 160 boats and takes seconds: measuring at module scope would put
 * that work in vitest's collection phase, where no test timeout applies and a slow runner looks
 * like a hang rather than a slow test.
 */
const cache = new Map<string, Measured>();
function measured(name: string): Measured {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const options = CASES[name]?.options;
  if (options === undefined) throw new Error(`no scenario named ${name}`);
  const fresh = measure(options);
  cache.set(name, fresh);
  return fresh;
}

/** Long enough for `worst`; every other scenario is a fraction of a second. */
const SLOW = 60_000;

describe.each(Object.entries(CASES))('%s', (name, { baseline }) => {
  it(
    'deploys the fixture it says it does',
    () => {
      const actual = measured(name);
      // A guard on the *scenario*, not on the netcode. If the deployment logic changes what a fleet
      // looks like, every byte figure below moves for a reason that has nothing to do with the wire,
      // and this is the assertion that says so first.
      expect(actual.boats).toBe(baseline.boats);
      expect(actual.recipients).toBe(baseline.recipients);
      expect(actual.publishes).toBe(baseline.publishes);
    },
    SLOW,
  );

  it(
    'puts exactly the recorded number of bytes on the wire',
    () => {
      const actual = measured(name);
      expect(
        actual.totalBytes,
        `total bytes moved ${drift(actual.totalBytes, baseline.totalBytes)} — ` +
          `if that was the intent, update the baseline in this file`,
      ).toBe(baseline.totalBytes);
    },
    SLOW,
  );

  it(
    'builds view frames of exactly the recorded size',
    () => {
      const actual = measured(name);
      expect(actual.p50, `p50 view frame moved ${drift(actual.p50, baseline.p50)}`).toBe(
        baseline.p50,
      );
      expect(actual.p95, `p95 view frame moved ${drift(actual.p95, baseline.p95)}`).toBe(
        baseline.p95,
      );
    },
    SLOW,
  );

  it(
    'does not widen the gap to the planning/02 §6 budget',
    () => {
      const actual = measured(name);
      // The ratchet. The budget is not met today — see this file's header — so what is asserted is
      // the direction of travel: p95 bytes per second per player may fall and may not rise.
      const perSec = actual.p95 * FRAMES_PER_SEC;
      const baselinePerSec = baseline.p95 * FRAMES_PER_SEC;
      expect(
        perSec,
        `${(perSec / 1024).toFixed(1)} KB/s per player at p95, against a budget of 8.0 KB/s — ` +
          `${(perSec / BUDGET_BYTES_PER_SEC).toFixed(1)}× over (was ` +
          `${(baselinePerSec / BUDGET_BYTES_PER_SEC).toFixed(1)}×)`,
      ).toBeLessThanOrEqual(baselinePerSec);
    },
    SLOW,
  );
});

describe('the measurement itself', () => {
  it('is deterministic — two runs of one scenario agree to the byte', () => {
    // Without this every other assertion in the file is noise dressed as a fact. It is also the
    // cheapest determinism check the simulation has: two `MatchRuntime`s driven identically must
    // produce identical wire bytes, which is planning/04 §9's claim measured rather than asserted.
    const options = CASES.duel?.options;
    if (options === undefined) throw new Error('missing duel scenario');

    const first = measure(options);
    const second = measure(options);

    expect(second.totalBytes).toBe(first.totalBytes);
    expect(second.frameSizes).toEqual(first.frameSizes);
  });

  it(
    'grows with the fleet, so the fixtures are actually measuring something',
    () => {
      const sizes = ['quiet', 'duel', 'typical', 'worst'].map((name) => measured(name).p95);
      expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    },
    SLOW,
  );

  it(
    'records what the budget gap currently is, so nobody has to re-derive it',
    () => {
      // Not a threshold — a note in executable form. planning/02 §6 predicted ~90 KB/s for the JSON
      // era before its levers; the worst case here is three times that, and the design target is
      // already 6.6× over. Both numbers are load-bearing for planning/17 §5's build order.
      const over = (frame: number): number => (frame * FRAMES_PER_SEC) / BUDGET_BYTES_PER_SEC;
      expect(over(measured('worst').p95)).toBeGreaterThan(20);
      expect(over(measured('typical').p95)).toBeGreaterThan(5);
    },
    SLOW,
  );
});
