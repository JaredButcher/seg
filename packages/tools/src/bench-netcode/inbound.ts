/**
 * What a client message costs the server before anything decides whether it was allowed.
 *
 * Two questions, and the second is the one that matters (planning/17 §3.5):
 *
 * 1. What does an ordinary command cost — decode, dispatch, apply?
 * 2. What does a **flood** cost? planning/02 §7 specifies a token bucket at 20/s burst and 5/s
 *    sustained, and **it is not built.** Today the only inbound limit in the tree is
 *    `MAX_MESSAGE_BYTES` = 8192 in `WsTransport.handleInbound`. So the answer to "what does a
 *    connection sending flat out cost" is currently "everything up to dispatch, per message,
 *    unbounded", and this bench is what turns that sentence into a number.
 *
 *   pnpm bench:netcode:inbound
 *   SCENARIO=worst pnpm bench:netcode:inbound
 *
 * ## Why the number decides where the bucket goes
 *
 * If decode dominates, the bucket must sit in the transport, **before** `codec.decode` — counting
 * frames and bytes, which is all a transport can see. If dispatch and apply dominate, it can sit
 * in the handler where the message type is known and a nicer `rejected` can be sent back. This
 * bench is the argument for one or the other, and it should be re-run when the bucket is built.
 *
 * ## The oversize path is measured separately, and it is not free
 *
 * A message over the cap is rejected without being decoded — but it has already been received,
 * copied out of the socket, and length-checked. `toBytes` in `WsTransport` may concatenate
 * fragments before anyone looks at the size. That is the cheapest possible reject and it is still
 * proportional to what the attacker sent.
 */

import {
  JsonCodec,
  createNavCancel,
  createNavOrder,
  createNavThrottle,
  type Message,
} from '@seg/shared';
import { isMatchMessage } from '@seg/server/match/index';

import { NetBench, best, optionsFromEnv } from './scenario.js';

const options = optionsFromEnv();
const codec = new JsonCodec();

const bench = new NetBench(options, 'inbound');
bench.warmUp();

const boats = bench.state.boats
  .filter((boat) => boat.owner === bench.recipients[0]?.accountId)
  .map((boat) => boat.id);
const sender = bench.recipients[0];
if (sender === undefined || boats.length === 0) {
  throw new Error('inbound bench needs a player with at least one boat');
}

// ── The corpus ────────────────────────────────────────────────────────────────────────

/**
 * The commands one player can actually issue, against boats they actually own.
 *
 * Ownership matters: a command for somebody else's boat is rejected early and would measure the
 * reject path while claiming to measure the apply path. `nav.order` is the expensive one — it
 * replaces a route — and it is deliberately first.
 */
const corpus: readonly Message[] = boats.flatMap((boat, i) => [
  createNavOrder(boat, { x: 1500 + i * 37.5, y: 900 + i * 12.25 }, i % 4 === 0),
  createNavThrottle(boat, i % 2 === 0 ? 'full' : 'flank'),
  createNavCancel(boat),
]);

const encoded = corpus.map((message) => codec.encode(message));
const corpusBytes = encoded.reduce((sum, buffer) => sum + buffer.byteLength, 0);

/** A message at the inbound cap, which is the largest thing a connection is allowed to send. */
const oversize = codec.encode({
  t: 'chat.send',
  scope: 'all',
  text: 'x'.repeat(9000),
} as Message);

// ── Measurement ───────────────────────────────────────────────────────────────────────

function time(label: string, body: () => void): { label: string; ms: number } {
  for (let i = 0; i < 3; i += 1) body();
  const samples: number[] = [];
  for (let run = 0; run < options.runs; run += 1) {
    const started = performance.now();
    body();
    samples.push(performance.now() - started);
  }
  return { label, ms: best(samples) };
}

let sink = 0;

const decodeOnly = time('decode', () => {
  for (const buffer of encoded) sink += codec.decode(buffer).t.length;
});

const decodeAndDispatch = time('decode + dispatch + apply', () => {
  for (const buffer of encoded) {
    const message = codec.decode(buffer);
    if (isMatchMessage(message)) bench.handler.handle(sender, message);
  }
});

// The reject path: over the cap, so `WsTransport` closes the connection without decoding. What is
// measured is what the process pays before it knows that — the copy and the length check.
const rejectOversize = time('reject oversize (no decode)', () => {
  for (let i = 0; i < encoded.length; i += 1) {
    const copy = new Uint8Array(oversize.byteLength);
    copy.set(oversize);
    sink += copy.byteLength > 8192 ? 1 : 0;
  }
});

const results = [decodeOnly, decodeAndDispatch, rejectOversize];

// ── Output ────────────────────────────────────────────────────────────────────────────

console.log(bench.describe());
console.log(
  `\n  corpus: ${corpus.length} commands over ${boats.length} owned boats, ` +
    `${corpusBytes} bytes (${(corpusBytes / corpus.length).toFixed(0)} per message)\n` +
    `  ${options.runs} runs, minimum reported\n`,
);

for (const result of results) {
  console.log(
    `  ${result.label.padEnd(28)} ${result.ms.toFixed(3).padStart(8)} ms  ` +
      `${((1000 * result.ms) / corpus.length).toFixed(2).padStart(7)} µs/msg`,
  );
}

const perMessageUs = (1000 * decodeAndDispatch.ms) / corpus.length;

console.log(
  `\n  dispatch and apply are ` +
    `${(((decodeAndDispatch.ms - decodeOnly.ms) / Math.max(1e-9, decodeAndDispatch.ms)) * 100).toFixed(0)}% ` +
    `of the inbound path; decode is the rest.\n` +
    `  planning/17 §3.5: if decode dominates, the token bucket belongs in the transport before\n` +
    `  \`codec.decode\`. If dispatch does, it belongs in the handler where the type is known.`,
);

// ── What a flood costs, in the units a capacity plan is written in ────────────────────

const budgetMs = 50;
const perTick = budgetMs / (perMessageUs / 1000);
console.log(
  `\n  a flood, with no token bucket (planning/02 §7 specifies one; it is not built)\n` +
    `    one message                 ${perMessageUs.toFixed(2)} µs\n` +
    `    to fill one 50 ms tick      ${Math.round(perTick).toLocaleString()} messages\n` +
    `    across all connections      that is ${Math.round(perTick / 20).toLocaleString()} msg/s from one client\n` +
    `                                against the ~1 command/s the *game* ever needs`,
);

console.log(
  `\n  the game's own rate is 1 command/s per player (planning/02 §7). At ${options.players} players\n` +
    `  that is ${((options.players * perMessageUs) / 1000).toFixed(3)} ms/s of inbound work — inbound is not a capacity\n` +
    `  problem, it is an abuse problem, and the bucket is the fix rather than the speed.`,
);

if (sink === Number.MIN_SAFE_INTEGER) console.log('unreachable');
