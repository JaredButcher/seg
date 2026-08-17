/**
 * What the codec costs, per message type, in both directions.
 *
 * Small, and the reason to build it now — with exactly one codec — is the same reason
 * planning/02 §9 step 1 builds the `Link` with exactly one transport: when `BinaryCodec` arrives
 * it runs through here unchanged, and the comparison that decides whether it was worth building
 * already exists. planning/13 §7's differential *correctness* tests get a performance counterpart
 * for free on the same day.
 *
 *   pnpm bench:netcode:codec
 *   SCENARIO=worst pnpm bench:netcode:codec      # the corpus a 16-player match generates
 *
 * ## The corpus is captured, not written
 *
 * Every message measured here came off a real publish of a real match. A hand-written fixture
 * would measure whatever its author imagined a frame looks like, and the bandwidth bench has
 * already shown that intuition is wrong about frames by an order of magnitude — planning/02 §6
 * expected contacts and echo returns to dominate, and it is own-team boat state that does.
 *
 * ## Decode is measured because the *client* is not the only one who decodes
 *
 * Downstream decode is the client's problem and low priority (planning/17's header). Upstream
 * decode is the server's, on every command from every player, and it is the same code. Splitting
 * the table by direction keeps the two from being averaged into one meaningless number.
 */

import {
  JsonCodec,
  createMatchView,
  createNavOrder,
  createNavThrottle,
  createNavCancel,
  type Message,
} from '@seg/shared';

import { NetBench, best, optionsFromEnv } from './scenario.js';

const options = optionsFromEnv();
const codec = new JsonCodec();

// ── The corpus ────────────────────────────────────────────────────────────────────────

const outbound = captureOutbound();
const inbound = syntheticInbound();

/**
 * The server → client frames a real match produces, taken through the real handler.
 *
 * `match.view` is the only outbound type that recurs at rate — everything else on `control` is
 * once a match or once a chat line — so it is the only one whose throughput is worth a column.
 */
function captureOutbound(): readonly Message[] {
  const bench = new NetBench(options, 'codec');
  bench.warmUp();

  const captured: Message[] = [];
  for (let tick = 0; tick < options.ticks; tick += 1) {
    if (!bench.tick()) continue;
    bench.publish();
    const view = bench.lastView;
    // One recipient's frame per publish rather than all of them: the table is per message, and
    // sixteen near-identical copies would weight the corpus by fixture size rather than by cost.
    if (view !== undefined) captured.push(createMatchView('codec', captured.length + 1, view));
  }
  return captured;
}

/**
 * The command traffic a player generates, at the shapes `handler.handle` accepts.
 *
 * Synthetic rather than captured because nothing in this repo drives a client — but these are
 * built by the same `create*` helpers the client calls, so the shapes cannot drift from the
 * schema without this file failing to compile.
 */
function syntheticInbound(): readonly Message[] {
  const messages: Message[] = [];
  for (let i = 1; i <= 20; i += 1) {
    messages.push(createNavOrder(i, { x: 1234.5, y: 678.25 }, i % 3 === 0));
    messages.push(createNavThrottle(i, i % 2 === 0 ? 'full' : 'flank'));
    messages.push(createNavCancel(i));
  }
  return messages;
}

// ── Measurement ───────────────────────────────────────────────────────────────────────

interface Result {
  readonly label: string;
  readonly messages: number;
  readonly bytes: number;
  /** Minimum ms for one pass over the whole corpus. */
  readonly encodeMs: number;
  readonly decodeMs: number;
}

function measure(label: string, corpus: readonly Message[]): Result {
  if (corpus.length === 0) {
    return { label, messages: 0, bytes: 0, encodeMs: 0, decodeMs: 0 };
  }

  const encoded = corpus.map((message) => codec.encode(message));
  const bytes = encoded.reduce((sum, buffer) => sum + buffer.byteLength, 0);

  // Warm up both directions before either is timed, so neither pays the other's interpreter cost.
  for (let i = 0; i < 3; i += 1) {
    for (const message of corpus) codec.encode(message);
    for (const buffer of encoded) codec.decode(buffer);
  }

  const encodeSamples: number[] = [];
  const decodeSamples: number[] = [];
  for (let run = 0; run < options.runs; run += 1) {
    let sink = 0;

    const e0 = performance.now();
    for (const message of corpus) sink += codec.encode(message).byteLength;
    encodeSamples.push(performance.now() - e0);

    const d0 = performance.now();
    for (const buffer of encoded) sink += codec.decode(buffer).t.length;
    decodeSamples.push(performance.now() - d0);

    if (sink === Number.MIN_SAFE_INTEGER) console.log('unreachable');
  }

  return {
    label,
    messages: corpus.length,
    bytes,
    encodeMs: best(encodeSamples),
    decodeMs: best(decodeSamples),
  };
}

const results = [
  measure('outbound (match.view)', outbound),
  measure('inbound (commands)', inbound),
];

// ── Output ────────────────────────────────────────────────────────────────────────────

console.log(`codec=JsonCodec  ${options.runs} runs, minimum reported`);
console.log(
  `  corpus from: ${options.players}p×${options.boats}b ${options.mapType}/${options.mapSize}\n`,
);

console.log(
  `  ${'corpus'.padEnd(22)} ${'msgs'.padStart(5)} ${'bytes'.padStart(9)} ` +
    `${'encode'.padStart(9)} ${'MB/s'.padStart(8)} ${'µs/msg'.padStart(8)} ` +
    `${'decode'.padStart(9)} ${'MB/s'.padStart(8)} ${'µs/msg'.padStart(8)}`,
);

for (const result of results) {
  if (result.messages === 0) continue;
  console.log(
    `  ${result.label.padEnd(22)} ${String(result.messages).padStart(5)} ` +
      `${String(result.bytes).padStart(9)} ` +
      `${result.encodeMs.toFixed(2).padStart(8)}m ${rate(result.bytes, result.encodeMs).padStart(8)} ` +
      `${((1000 * result.encodeMs) / result.messages).toFixed(1).padStart(8)} ` +
      `${result.decodeMs.toFixed(2).padStart(8)}m ${rate(result.bytes, result.decodeMs).padStart(8)} ` +
      `${((1000 * result.decodeMs) / result.messages).toFixed(1).padStart(8)}`,
  );
}

function rate(bytes: number, ms: number): string {
  if (ms <= 0) return '—';
  return ((bytes / 1e6 / ms) * 1000).toFixed(0);
}

// The number planning/17 §2.1 guessed at with an order of magnitude of uncertainty, now measured.
const view = results[0];
if (view !== undefined && view.messages > 0) {
  const perFrame = (1000 * view.encodeMs) / view.messages;
  const players = options.players + options.spectators;
  console.log(
    `\n  one ${options.players}-player publish encodes ${players} frames: ` +
      `${((perFrame * players) / 1000).toFixed(3)} ms\n` +
      `  planning/17 §2.1 guessed 0.15–1 ms for a 16-player publish and said so; this is the answer.`,
  );
}
