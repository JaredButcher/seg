/**
 * Where one publish goes, broken into the four phases a frame is built in.
 *
 * The primary server-side instrument, and the counterpart to `bench-acoustics/solve-phases.ts`
 * one level up: that one measures what the *world* costs, this one measures what **telling
 * everybody about it** costs. planning/17 §1.5 is why the two are separate budgets —
 * `MatchHandler.publish` runs after `MatchRuntime.tick` returns, outside the tick total but inside
 * the same serial loop over every match on the process.
 *
 *   pnpm bench:netcode                                  # 3v3, four boats each, dense/medium
 *   SCENARIO=worst pnpm bench:netcode                    # 8v8 × 10 boats — planning/02 §6's case
 *   SCENARIO=quiet pnpm bench:netcode                    # the floor
 *   PLAYERS=16 BOATS=2 pnpm bench:netcode                # many players, few boats
 *   PLAYERS=4  BOATS=10 pnpm bench:netcode               # few players, many boats
 *
 * The last two are the pair that answers **Q-17.1** (planning/17 §2.1): the acoustic solve is
 * per *team* and publishing is per *player*, so holding the boat count roughly fixed while moving
 * players is the sweep that shows which line is steeper. `scaling.ts` runs the whole matrix.
 *
 * ## What the four phases are, and what a reader should compare them against
 *
 * - `vision` — `MatchRuntime.visionFor`, slicing the team's picture against this recipient's chart
 *   watermark. Should be small and should *stay* small; if it is not, the watermark is not doing
 *   its job and the chart is being re-sent.
 * - `assemble` — `shared/match/view.ts#viewFor`, allocating the `MatchViewState`. Every object in
 *   a frame is fresh every frame, so this is also where GC pressure is born (planning/17 §6.6).
 * - `encode` — `JSON.stringify` plus `TextEncoder`. The phase a binary codec replaces.
 * - `send` — handing bytes to the transport. Near zero here by construction: the bench drops the
 *   buffer where production hands it to `ws`. **Do not read this column as production's send
 *   cost.** It is here so the other three add up, and so the day it stops being near zero is
 *   visible.
 */

import { encoderResidue, NetBench, best, emptyPhases, kb, optionsFromEnv } from './scenario.js';
import type { PublishPhases } from './scenario.js';

const options = optionsFromEnv();
const runs: PublishPhases[] = [];

for (let run = 0; run < options.runs; run += 1) {
  const bench = new NetBench(options, `bench-${run}`);
  bench.warmUp();

  const totals = emptyPhases();
  for (let tick = 0; tick < options.ticks; tick += 1) {
    if (!bench.tick()) continue;
    const phases = bench.publishByPhase();
    totals.vision += phases.vision;
    totals.assemble += phases.assemble;
    totals.encode += phases.encode;
    totals.send += phases.send;
    totals.total += phases.total;
    totals.frames += phases.frames;
  }

  // Per publish, not per run: a run is however many frames `TICKS` came due in, and comparing two
  // runs with different tick counts is comparing nothing.
  const publishes = Math.max(1, totals.frames / Math.max(1, recipientCount(bench)));
  runs.push({
    vision: totals.vision / publishes,
    assemble: totals.assemble / publishes,
    encode: totals.encode / publishes,
    send: totals.send / publishes,
    total: totals.total / publishes,
    frames: totals.frames / publishes,
  });
}

function recipientCount(bench: NetBench): number {
  return bench.recipients.length;
}

// A fresh bench for the byte figures, so they are taken on a steady state rather than averaged
// across five runs that each began with a warm-up.
const sample = new NetBench(options, 'bench-sample');
sample.warmUp();
let publishes = 0;
for (let tick = 0; tick < options.ticks; tick += 1) {
  if (!sample.tick()) continue;
  sample.publish();
  publishes += 1;
}

console.log(sample.describe());

const phase = <K extends keyof PublishPhases>(key: K): number => best(runs.map((run) => run[key]));
const total = phase('total');
const frames = runs[0]?.frames ?? 0;

console.log(
  `\n${options.runs} runs, minimum of each — ${total.toFixed(3)} ms per publish, ` +
    `${frames.toFixed(0)} frames each, ${((1000 * total) / Math.max(1, frames)).toFixed(1)} µs ` +
    `per player-frame\n`,
);

for (const key of ['assemble', 'encode', 'vision', 'send'] as const) {
  const ms = phase(key);
  console.log(
    `  ${key.padEnd(9)} ${ms.toFixed(3).padStart(7)} ms  ${((100 * ms) / total).toFixed(1).padStart(5)}%` +
      `  ${((1000 * ms) / Math.max(1, frames)).toFixed(1).padStart(6)} µs/frame`,
  );
}

const accounted = phase('vision') + phase('assemble') + phase('encode') + phase('send');
console.log(
  `  ${'unattributed'.padEnd(9)} ${(total - accounted).toFixed(3).padStart(4)} ms  ` +
    `— loop overhead and whatever fell between the four`,
);

// The bytes, from the real handler path rather than from the mirror.
const bytes = sample.bytes;
const perFrame = bytes / Math.max(1, sample.recipients.length * publishes);
console.log(
  `\n  bytes — ${kb(perFrame)} per player-frame, ` +
    `${kb((perFrame * 1000) / 100)}/s per player at the 10 Hz frame rate\n` +
    `  ${kb(bytes / Math.max(1, publishes))} per publish across ${sample.recipients.length} recipients`,
);

// planning/17 §1.5: the figure that matters is not this match's share of its own budget, it is
// its share of the budget every match on the process is sharing.
console.log(
  `\n  publish is ${((100 * total) / 50).toFixed(1)}% of one 50 ms tick — and that tick belongs\n` +
    `  to every match on the process, not to this one (planning/17 §1.5)`,
);

if (encoderResidue() === Number.MIN_SAFE_INTEGER) console.log('unreachable');
