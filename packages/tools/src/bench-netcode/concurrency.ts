/**
 * How many matches fit on one process before ticks start arriving late.
 *
 * The benchmark planning/17 §1.5 exists to justify. `server/match/clock.ts` walks every running
 * match through **one `setInterval`, serially**, and deliberately does not catch up: a process that
 * fell behind runs the next tick late rather than running two back to back. So the failure mode is
 * not a slow tick, it is a **late** one, and the capacity figure for a deployment is the largest
 * `M` at which that does not happen.
 *
 * This subsumes planning/13 §9's `bench-tick`: a single worst-case match is the `M = 1` row.
 *
 *   pnpm bench:netcode:concurrency                       # sweep 1,2,4,8,16 at the design target
 *   SCENARIO=worst MATCHES_AXIS=1,2,4 pnpm bench:netcode:concurrency
 *   SECONDS=6 pnpm bench:netcode:concurrency             # longer, so GC pauses land in the sample
 *
 * ## Why it is paced in real time rather than run flat out
 *
 * Running steps back to back measures throughput, and throughput is not the question. A server at
 * 90% utilization is fine and a server that misses one tick in fifty is not, and only a paced loop
 * can tell those apart. Pacing also puts **GC pauses** in the sample, which matters more here than
 * anywhere else in this directory: every frame allocates a fresh `MatchViewState` and every array
 * inside it, so the cost of publishing shows up partly as time in `assemble` and partly as a pause
 * that lands on some unrelated tick later (planning/17 §6.6).
 *
 * That is also why **slip is reported as a distribution and never as a mean.** A mean slip of 2 ms
 * hides a p99 of 60 ms, and the p99 is the one a player feels.
 */

import { NetProcess, best, kb, optionsFromEnv, percentile } from './scenario.js';

const options = optionsFromEnv();
const axis = readAxis(process.env.MATCHES_AXIS, [1, 2, 4, 8, 16]);
const seconds = Number(process.env.SECONDS ?? 4);
/** planning/04 §1: the sim runs at 20 Hz, so a tick is due every 50 ms. */
const PERIOD_MS = 50;

function readAxis(raw: string | undefined, fallback: readonly number[]): readonly number[] {
  if (raw === undefined) return fallback;
  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  return parsed.length > 0 ? parsed : fallback;
}

interface Row {
  readonly matches: number;
  readonly players: number;
  /** Busy milliseconds per step — the process's own work, excluding the wait. */
  readonly busyP50: number;
  readonly busyP90: number;
  readonly busyP99: number;
  /** How late each step started against its deadline, ms. */
  readonly slipP50: number;
  readonly slipP99: number;
  readonly slipMax: number;
  /** Busy time ÷ wall time. Above 1.0 the process cannot keep up at all. */
  readonly utilization: number;
  readonly bytesPerSec: number;
  readonly steps: number;
}

const rows: Row[] = [];

for (const matches of axis) {
  rows.push(await run(matches));
  // A pause between points, so one sweep's garbage is not the next one's latency.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function run(matches: number): Promise<Row> {
  const process_ = new NetProcess({ ...options, matches }, matches);
  process_.warmUp();

  const steps = Math.max(1, Math.round((seconds * 1000) / PERIOD_MS));
  const busy: number[] = [];
  const slip: number[] = [];

  const started = performance.now();
  for (let i = 0; i < steps; i += 1) {
    const deadline = started + i * PERIOD_MS;
    const wait = deadline - performance.now();
    // Yielding even when there is nothing to wait for matters: it is what lets the event loop —
    // and therefore the GC, and in production the sockets — get a turn, which is the whole
    // difference between this and a flat-out loop.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));

    const began = performance.now();
    slip.push(began - deadline);
    process_.step();
    busy.push(performance.now() - began);
  }
  const wall = performance.now() - started;
  const busyTotal = busy.reduce((sum, ms) => sum + ms, 0);

  return {
    matches,
    players: process_.recipients.length,
    busyP50: percentile(busy, 50),
    busyP90: percentile(busy, 90),
    busyP99: percentile(busy, 99),
    slipP50: percentile(slip, 50),
    slipP99: percentile(slip, 99),
    slipMax: percentile(slip, 100),
    utilization: busyTotal / Math.max(1, wall),
    bytesPerSec: (process_.bytes / Math.max(1, wall)) * 1000,
    steps,
  };
}

// ── Output ────────────────────────────────────────────────────────────────────────────

console.log(
  `${options.players}p×${options.boats}b per match, ${options.hull}, ${options.throttle}, ` +
    `map=${options.mapType}/${options.mapSize}\n` +
    `  ${seconds}s per point at ${PERIOD_MS} ms (${Math.round((seconds * 1000) / PERIOD_MS)} steps), ` +
    `${options.warmup} warm-up\n`,
);

console.log(
  `  ${'matches'.padStart(7)} ${'conns'.padStart(5)} ` +
    `${'busy p50'.padStart(9)} ${'busy p90'.padStart(9)} ${'busy p99'.padStart(9)} ` +
    `${'slip p50'.padStart(9)} ${'slip p99'.padStart(9)} ${'slip max'.padStart(9)} ` +
    `${'util'.padStart(6)} ${'egress'.padStart(11)}`,
);

for (const row of rows) {
  const late = row.slipP99 > PERIOD_MS;
  console.log(
    `  ${String(row.matches).padStart(7)} ${String(row.players).padStart(5)} ` +
      `${row.busyP50.toFixed(1).padStart(8)}m ${row.busyP90.toFixed(1).padStart(8)}m ` +
      `${row.busyP99.toFixed(1).padStart(8)}m ` +
      `${row.slipP50.toFixed(1).padStart(8)}m ${row.slipP99.toFixed(1).padStart(8)}m ` +
      `${row.slipMax.toFixed(1).padStart(8)}m ` +
      `${(100 * row.utilization).toFixed(0).padStart(5)}% ` +
      `${(kb(row.bytesPerSec) + '/s').padStart(11)}` +
      (late ? '  ← p99 slip over one tick' : ''),
  );
}

// ── The knee ──────────────────────────────────────────────────────────────────────────

const healthy = rows.filter((row) => row.slipP99 <= PERIOD_MS && row.utilization < 0.9);
const knee = healthy[healthy.length - 1];
const firstBad = rows.find((row) => row.slipP99 > PERIOD_MS || row.utilization >= 0.9);

console.log(
  `\n  **Read busy p90, not busy p50.** The acoustic solve and the view frames run on every\n` +
    `  *second* tick (\`ACOUSTIC_TICK_HZ\`), so half the steps here do almost nothing and p50 is\n` +
    `  the cheap half. p90 is a publishing tick; p99 is a publishing tick that met the GC.`,
);

console.log(
  `\n  ceiling on this box: ` +
    (knee === undefined
      ? 'below the smallest point swept'
      : firstBad === undefined
        ? `at least ${knee.matches} concurrent ${options.players}-player matches — the sweep never ` +
          `found the knee, so raise MATCHES_AXIS`
        : `${knee.matches} concurrent ${options.players}-player matches (${firstBad.matches} is already over)`),
);

if (knee !== undefined) {
  console.log(
    `  that is ${knee.players} connections and ${kb(knee.bytesPerSec)}/s of egress off one process.\n` +
      `  Q-17.4 (planning/17 §10) wants this number for the deployment box, not this one — re-run\n` +
      `  it there before quoting it in deploy/README.md.`,
  );
}

// planning/17 §6.4: this is the measurement that settles which parallelism is worth building, and
// it is deliberately printed rather than left for a reader to infer.
const busiest = rows[rows.length - 1];
if (busiest !== undefined) {
  const perMatch = best(rows.map((row) => row.busyP50 / row.matches));
  console.log(
    `\n  ${perMatch.toFixed(2)} ms of busy time per match per tick, at the cheapest point measured.\n` +
      `  Q-17.3 — if a deployment runs many small matches, shard *matches* across workers\n` +
      `  (planning/17 §6.3 B) and per-publish parallelism buys nothing. If it runs a few large\n` +
      `  ones, the opposite. This sweep says which regime the box is in; it does not say which\n` +
      `  regime the game is in — that needs real lobbies.`,
  );
}
