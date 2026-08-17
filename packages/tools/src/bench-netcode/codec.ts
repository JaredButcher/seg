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
  BinaryCodec,
  JsonCodec,
  createMatchView,
  createNavOrder,
  createNavThrottle,
  createNavCancel,
  type Codec,
  type Message,
} from '@seg/shared';

import { NetBench, best, optionsFromEnv } from './scenario.js';

const options = optionsFromEnv();

/**
 * The codecs under test, in the order the table lists them.
 *
 * Adding `BinaryCodec` here is the whole reason this bench was built with one codec in it
 * (planning/02 §9 step 1's reasoning, applied to the codec seam): the corpus, the timing and the
 * warm-up were already right, so the second codec cost one line.
 */
const CODECS: readonly (readonly [string, Codec])[] = [
  ['JsonCodec', new JsonCodec()],
  ['BinaryCodec', new BinaryCodec()],
];

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
  readonly corpus: string;
  readonly codec: string;
  readonly messages: number;
  readonly bytes: number;
  /** Minimum ms for one pass over the whole corpus. */
  readonly encodeMs: number;
  readonly decodeMs: number;
}

function measure(
  corpusName: string,
  corpus: readonly Message[],
  name: string,
  under: Codec,
): Result {
  if (corpus.length === 0) {
    return { corpus: corpusName, codec: name, messages: 0, bytes: 0, encodeMs: 0, decodeMs: 0 };
  }

  const encoded = corpus.map((message) => under.encode(message));
  const bytes = encoded.reduce((sum, buffer) => sum + buffer.byteLength, 0);

  // Warm up both directions before either is timed, so neither pays the other's interpreter cost.
  for (let i = 0; i < 3; i += 1) {
    for (const message of corpus) under.encode(message);
    for (const buffer of encoded) under.decode(buffer);
  }

  const encodeSamples: number[] = [];
  const decodeSamples: number[] = [];
  for (let run = 0; run < options.runs; run += 1) {
    let sink = 0;

    const e0 = performance.now();
    for (const message of corpus) sink += under.encode(message).byteLength;
    encodeSamples.push(performance.now() - e0);

    const d0 = performance.now();
    for (const buffer of encoded) sink += under.decode(buffer).t.length;
    decodeSamples.push(performance.now() - d0);

    if (sink === Number.MIN_SAFE_INTEGER) console.log('unreachable');
  }

  return {
    corpus: corpusName,
    codec: name,
    messages: corpus.length,
    bytes,
    encodeMs: best(encodeSamples),
    decodeMs: best(decodeSamples),
  };
}

const results = [
  ...CODECS.map(([name, under]) => measure('outbound (match.view)', outbound, name, under)),
  ...CODECS.map(([name, under]) => measure('inbound (commands)', inbound, name, under)),
];

// ── Output ────────────────────────────────────────────────────────────────────────────

console.log(`${options.runs} runs, minimum reported`);
console.log(
  `  corpus from: ${options.players}p×${options.boats}b ${options.mapType}/${options.mapSize}\n`,
);

console.log(
  `  ${'corpus'.padEnd(22)} ${'codec'.padEnd(12)} ${'msgs'.padStart(5)} ${'bytes'.padStart(9)} ` +
    `${'B/msg'.padStart(7)} ${'encode µs'.padStart(10)} ${'decode µs'.padStart(10)}`,
);

for (const result of results) {
  if (result.messages === 0) continue;
  console.log(
    `  ${result.corpus.padEnd(22)} ${result.codec.padEnd(12)} ${String(result.messages).padStart(5)} ` +
      `${String(result.bytes).padStart(9)} ` +
      `${(result.bytes / result.messages).toFixed(0).padStart(7)} ` +
      `${((1000 * result.encodeMs) / result.messages).toFixed(1).padStart(10)} ` +
      `${((1000 * result.decodeMs) / result.messages).toFixed(1).padStart(10)}`,
  );
}

// The comparison the whole file exists for, stated rather than left to be worked out from a table.
for (const corpusName of ['outbound (match.view)', 'inbound (commands)']) {
  const rows = results.filter((r) => r.corpus === corpusName && r.messages > 0);
  const json = rows.find((r) => r.codec === 'JsonCodec');
  const bin = rows.find((r) => r.codec === 'BinaryCodec');
  if (json === undefined || bin === undefined) continue;
  console.log(
    `\n  ${corpusName}: binary is ` +
      `${(json.bytes / bin.bytes).toFixed(1)}× smaller, ` +
      `${(json.encodeMs / bin.encodeMs).toFixed(1)}× to encode, ` +
      `${(json.decodeMs / bin.decodeMs).toFixed(1)}× to decode` +
      (bin.bytes === json.bytes ? '   (no schema — JSON fallback)' : ''),
  );
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
