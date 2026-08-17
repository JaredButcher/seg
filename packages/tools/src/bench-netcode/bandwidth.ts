/**
 * What the netcode actually puts on the wire, in real encoded bytes.
 *
 * planning/13 §9 has asked for this since M2 and planning/02 §6 sets the budget it is measured
 * against: **≤ 8 KB/s down per player at p95**, in the worst realistic case. Everything printed
 * here comes from `codec.encode(msg).byteLength` — not `JSON.stringify().length`, which counts
 * UTF-16 code units rather than bytes, and not an estimate.
 *
 *   pnpm bench:netcode:bandwidth                       # the design target, 3v3 × 4 boats
 *   SCENARIO=worst pnpm bench:netcode:bandwidth        # planning/02 §6's case: 8v8 × 10 boats
 *   SCENARIO=quiet pnpm bench:netcode:bandwidth        # the floor
 *   SCENARIO=burst pnpm bench:netcode:bandwidth        # every chart watermark back to zero
 *
 * ## Why this is the one benchmark that may assert an absolute
 *
 * Every timing in this repo is worth ±20% on an unpinned box and is not comparable across sessions
 * (planning/16 §6). **Bytes are exact.** For a fixed scenario and seed the numbers below are
 * identical on any machine, this year and next — which is what makes the CI budget in
 * `netcode-bandwidth.test.ts` a fact rather than a symptom of a busy runner, and what makes byte
 * counts the honest cross-session check that cell counts are for the acoustics (planning/17 §9).
 *
 * ## Three tables, because one number cannot be acted on
 *
 * 1. **By message type** — what to go and fix. A frame that is 70% one field is a different
 *    problem from one that is evenly spread.
 * 2. **By channel** — what planning/02 §6's dev overlay is specified in, and what decides how much
 *    the WebRTC split is worth: only the `view` share can ever move onto an unreliable channel.
 * 3. **Inside a view frame** — the actionable one. Every lever in planning/17 §5 targets a
 *    specific part of a frame, so the split across those parts *is* the priority order.
 */

import type { MatchViewState } from '@seg/shared';

import { NetBench, kb, optionsFromEnv, percentile, type NetBenchOptions } from './scenario.js';

/** planning/02 §6, the number this whole file exists to check. */
const BUDGET_BYTES_PER_SEC = 8 * 1024;
/** planning/02 §5: one view frame per acoustic solve, every second sim tick. */
const FRAMES_PER_SEC = 10;

const options = optionsFromEnv();
const bench = new NetBench(options, 'bandwidth');
bench.warmUp();

// The burst scenario is the whole point of `forgetCharts` — measured *after* the warm-up, so what
// it shows is a reconnect into a match already under way rather than a match that just started.
if (process.env.SCENARIO === 'burst') bench.forgetCharts();

let publishes = 0;
const frameSamples: MatchViewState[] = [];
for (let tick = 0; tick < options.ticks; tick += 1) {
  if (!bench.tick()) continue;
  bench.publish();
  publishes += 1;
  // One recipient's frame per publish, kept for the composition table. Rebuilding it here would
  // advance the watermark a second time (`MatchStore.viewFor` is explicit that it is not a pure
  // read), so it is captured from the runtime's own picture instead — see `captureFrame`.
  const frame = captureFrame(bench);
  if (frame !== undefined) frameSamples.push(frame);
}

console.log(bench.describe());
console.log(`\n  ${publishes} publishes to ${bench.recipients.length} recipients\n`);

// ── 1. By message type ────────────────────────────────────────────────────────────────

const meter = bench.codec.outbound;
const totals = meter.totals;
const seconds = publishes / FRAMES_PER_SEC;
const perPlayerPerSec =
  totals.bytes / Math.max(1, bench.recipients.length) / Math.max(1e-9, seconds);

console.log('  by message type');
console.log(
  `    ${'type'.padEnd(16)} ${'ch'.padEnd(9)} ${'count'.padStart(6)} ${'total'.padStart(10)} ${'mean'.padStart(8)} ${'peak'.padStart(8)}  share`,
);
for (const tally of meter.tallies()) {
  console.log(
    `    ${tally.type.padEnd(16)} ${tally.channel.padEnd(9)} ${String(tally.messages).padStart(6)} ` +
      `${kb(tally.bytes).padStart(10)} ${tally.mean.toFixed(0).padStart(8)} ${String(tally.peak).padStart(8)}  ` +
      `${((100 * tally.bytes) / Math.max(1, totals.bytes)).toFixed(1).padStart(5)}%`,
  );
}

// ── 2. By channel ─────────────────────────────────────────────────────────────────────

const byChannel = meter.byChannel();
console.log('\n  by channel');
for (const channel of ['view', 'control', 'commands'] as const) {
  const bytes = byChannel[channel];
  console.log(
    `    ${channel.padEnd(9)} ${kb(bytes).padStart(10)}  ` +
      `${((100 * bytes) / Math.max(1, totals.bytes)).toFixed(1).padStart(5)}%` +
      (channel === 'view' ? '   — the only share WebRTC can ever move (planning/02 §3)' : ''),
  );
}

// ── 3. Inside a view frame ────────────────────────────────────────────────────────────

const composition = compose(frameSamples);
if (composition.length > 0) {
  console.log('\n  inside a view frame (mean bytes, JSON, one recipient)');
  const frameTotal = composition.reduce((sum, part) => sum + part.bytes, 0);
  for (const part of composition) {
    console.log(
      `    ${part.name.padEnd(16)} ${part.bytes.toFixed(0).padStart(8)} ` +
        `${((100 * part.bytes) / Math.max(1, frameTotal)).toFixed(1).padStart(5)}%  ${part.note}`,
    );
  }
}

// ── The verdict ───────────────────────────────────────────────────────────────────────

const frameSizes = bench.recipients.flatMap((connection) => connection.frameSizes);
const p50 = percentile(frameSizes, 50);
const p95 = percentile(frameSizes, 95);
const max = percentile(frameSizes, 100);

console.log(
  `\n  view frames — p50 ${kb(p50)}  p95 ${kb(p95)}  max ${kb(max)}  (${frameSizes.length} samples)`,
);

const p95PerSec = p95 * FRAMES_PER_SEC;
const verdict = p95PerSec <= BUDGET_BYTES_PER_SEC ? 'WITHIN' : 'OVER';
console.log(
  `\n  per player, downstream — ${kb(perPlayerPerSec)}/s mean, ${kb(p95PerSec)}/s at p95\n` +
    `  budget is ${kb(BUDGET_BYTES_PER_SEC)}/s at p95 (planning/02 §6): **${verdict}**` +
    (verdict === 'OVER' ? ` by ${(p95PerSec / BUDGET_BYTES_PER_SEC).toFixed(1)}×` : ''),
);

console.log(egress(perPlayerPerSec, options));

// ── Helpers ───────────────────────────────────────────────────────────────────────────

/**
 * The `MatchViewState` from the last frame a recipient was actually sent.
 *
 * Read back off the connection rather than rebuilt, because building one advances the chart
 * watermark and the view sequence (`MatchStore.viewFor`) — a second build would report an empty
 * chart and mis-attribute the largest item in the table.
 */
function captureFrame(source: NetBench): MatchViewState | undefined {
  return source.lastView;
}

interface FramePart {
  readonly name: string;
  readonly bytes: number;
  readonly note: string;
}

/**
 * What a frame is made of, by encoding each part on its own.
 *
 * The parts do not sum to exactly the frame — key names and punctuation for the top-level object
 * are not attributed to anyone — which is deliberate. The question this table answers is "which
 * lever in planning/17 §5 is worth pulling", and for that a part's own encoded size is the honest
 * measure. A perfectly-summing table would need every byte assigned to somebody and would spend
 * its accuracy on brackets.
 */
function compose(frames: readonly MatchViewState[]): readonly FramePart[] {
  if (frames.length === 0) return [];
  const size = (pick: (frame: MatchViewState) => unknown): number =>
    frames.reduce((sum, frame) => sum + json(pick(frame)), 0) / frames.length;

  const parts: FramePart[] = [
    {
      name: 'own',
      bytes: size((f) => f.own),
      note: 'tubes, damage, orders — your boats only',
    },
    {
      name: 'boats',
      bytes: size((f) => f.boats),
      note: "your team's positions — quantization (§5 lever 1)",
    },
    {
      name: 'vision.cells',
      bytes: size((f) => [f.vision.cells, f.vision.strength]),
      note: 'faint returns — echo decimation (§5 lever 5)',
    },
    {
      name: 'vision.charted',
      bytes: size((f) => f.vision.charted),
      note: 'chart appends — watermarked, so ~0 in steady state',
    },
    {
      name: 'vision.contacts',
      bytes: size((f) => f.vision.contacts),
      note: 'held contacts — contact caps (§5 lever 4)',
    },
    {
      name: 'vision.alerts',
      bytes: size((f) => [f.vision.launches, f.vision.pings]),
      note: 'launches and pings heard — rare',
    },
    { name: 'torpedoes', bytes: size((f) => f.torpedoes), note: 'weapons in the water' },
    { name: 'wrecks', bytes: size((f) => f.wrecks), note: 'both teams, ungated' },
    {
      name: 'zones + teams',
      bytes: size((f) => [f.zones, f.teams]),
      note: 'objectives and scores — fixed cost',
    },
    { name: 'clock + phase', bytes: size((f) => [f.clock, f.phase]), note: 'per-frame constant' },
  ];
  return parts.sort((a, b) => b.bytes - a.bytes);
}

function json(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * The number planning/17 §5.1 derives from the budget, recomputed from what was actually measured.
 *
 * A single VM behind Caddy (`deploy/`) has no trouble with the bitrate. The monthly figure is the
 * one worth knowing before a bill arrives, and it is the first argument for the binary codec that
 * is about money rather than latency.
 */
function egress(bytesPerPlayerPerSec: number, o: NetBenchOptions): string {
  const perMatch = bytesPerPlayerPerSec * o.players;
  const tenMatches = perMatch * 10;
  const monthly = (tenMatches * 2_592_000) / 1e12;
  return (
    `\n  egress at this rate (planning/17 §5.1)\n` +
    `    one ${o.players}-player match   ${kb(perMatch)}/s\n` +
    `    ten of them                     ${((tenMatches * 8) / 1e6).toFixed(1)} Mbit/s\n` +
    `    sustained for a month           ${monthly.toFixed(1)} TB  — it will not be, but know the shape`
  );
}
