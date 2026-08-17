/**
 * @seg/server/realtime/compression — the `permessage-deflate` settings, and why each one.
 *
 * The cheapest bandwidth lever in the project and the one nobody had tried
 * ([planning/17 §5.2](../../../../planning/17-netcode-performance.md)). Per player, downstream,
 * measured on real captured frames at the settings below, against the 8 KB/s budget of
 * planning/02 §6:
 *
 * | scenario | uncompressed | + deflate | + deflate + `BinaryCodec` |
 * |---|---|---|---|
 * | `quiet` (1v1 × 1 boat) | 15.8 KB/s | 1.1 KB/s | **0.3 KB/s** |
 * | `typical` (3v3 × 4 boats) | 62.5 KB/s | 5.2 KB/s | **1.5 KB/s** |
 * | `worst` (8v8 × 10 boats) | 309.5 KB/s | 36.8 KB/s | **17.6 KB/s** |
 *
 * The design target is met by this option alone, and comfortably with the codec beside it. `worst`
 * is still 2.2× over and needs planning/17 §5's lever 5 — a cap on lit cells, which is a design
 * decision rather than an encoding one.
 *
 * ## Context takeover is the whole trick, so it stays on
 *
 * Per-frame deflate with no shared history is only 2.5–6.2×. **Context takeover** — keeping the
 * compressor's window alive between messages on a connection — is what turns that into 17–19×,
 * because consecutive view frames are nearly identical and the window has already seen the last
 * one. It is delta encoding's redundancy, harvested without a protocol change, without a desync
 * failure mode, and without a client deploy.
 *
 * `ws` keeps context by default. **Do not set `serverNoContextTakeover`** without re-reading that
 * paragraph: it would cost an order of magnitude and look like a memory optimization.
 *
 * ## What it costs, measured
 *
 * - **CPU:** 0.043 ms per `typical` frame at level 1 — 1.3× the `JSON.stringify` beside it. On
 *   `worst` it is 0.099 ms, which is *faster* than stringifying the same frame (0.151 ms): a frame
 *   that redundant compresses almost for free. Publishing is 1.4% of a tick (planning/17 §2.1), so
 *   this is affordable several times over.
 * - **Memory:** a zlib stream is **219 KB** per connection at Node's defaults and **113 KB** at the
 *   window below, and there is one each way. The window setting is the only reason this file has
 *   opinions rather than an empty object.
 *
 * ## Why level 1 and not the default 6
 *
 * Level 6 buys 4–11% more compression for 1.4–2.2× the CPU. On a server that is bandwidth-bound
 * and shares one thread between every match on the box (planning/17 §1.5), that is the wrong side
 * of the trade. Level 1 is also the level at which `worst` compresses faster than it serializes.
 */

import type { PerMessageDeflateOptions } from 'ws';

/**
 * `2^13` = 8 KB of sliding window, down from the 32 KB default, and **measured rather than
 * guessed** — the first draft of this file said 11 and it was the wrong number.
 *
 * The window has to hold the *previous frame* for context takeover to pay. So how small it can be
 * depends entirely on how big a frame is, which is to say on the codec:
 *
 * | window | KB/conn | JSON `typical` | binary `typical` | JSON `worst` | binary `worst` |
 * |---|---|---|---|---|---|
 * | 15 (default) | 219 | 3.6 KB/s | 1.5 KB/s | 28.6 KB/s | 17.8 KB/s |
 * | **13** | **113** | 5.2 KB/s | **1.5 KB/s** | 36.8 KB/s | **17.6 KB/s** |
 * | 11 | 83 | 11.3 KB/s | 1.6 KB/s | 42.3 KB/s | 20.3 KB/s |
 *
 * A JSON view frame is ~6.4 KB, so shrinking the window below it costs 3× — a 2 KB window cannot
 * see the frame before. A **binary** frame is ~530 B, so it fits many times over and the window
 * stops mattering: 13 is indistinguishable from the 32 KB default and saves half the memory.
 *
 * 13 is therefore the setting that is right under the binary codec and merely *acceptable* if
 * everything falls back to JSON. That asymmetry is the thing to remember: **if `BinaryCodec` is
 * ever turned off, re-raise this to 15** or bandwidth goes up 1.4×.
 *
 * Re-measure with `pnpm --filter @seg/tools bench:netcode:bandwidth` if frame sizes move.
 */
const WINDOW_BITS = 13;

/**
 * Below this many bytes, send uncompressed.
 *
 * A `pong` or a `cmdAck` is smaller than the deflate block header it would acquire. 512 sits under
 * every view frame measured (the smallest is ~1.6 KB) and over every control message, which is
 * exactly where the line belongs.
 */
const THRESHOLD_BYTES = 512;

/**
 * The settings, or `false` to turn the whole thing off.
 *
 * `false` is a real option and it is why this returns rather than exports a constant: planning/02
 * §9's rule is that every transport-shaped decision keeps a way back, and "is the compressor doing
 * something strange" is a question best answered by turning it off rather than by reasoning.
 */
export function deflateOptions(enabled: boolean): PerMessageDeflateOptions | false {
  if (!enabled) return false;
  return {
    // Level 1. See the header — 4–11% more compression is not worth 1.4–2.2× the CPU here.
    zlibDeflateOptions: { level: 1, memLevel: 6 },
    zlibInflateOptions: { chunkSize: 4 * 1024 },
    // Negotiated with the client; `ws` configures zlib's window from this rather than from
    // `zlibDeflateOptions.windowBits`, which is why the constant is spent here.
    serverMaxWindowBits: WINDOW_BITS,
    clientMaxWindowBits: WINDOW_BITS,
    threshold: THRESHOLD_BYTES,
    // How many messages may be inflating/deflating at once before `ws` queues them. The default is
    // 10 and it is a backpressure guard rather than a throughput knob: unbounded concurrency here
    // is how a burst of large inbound messages turns into unbounded memory.
    concurrencyLimit: 10,
  };
}

/**
 * Whether compression is on, from the environment.
 *
 * On by default. `SEG_WS_COMPRESSION=false` turns it off — for a bandwidth measurement that wants
 * raw frame sizes, or to answer "is it the compressor" during an incident.
 */
export function compressionEnabled(): boolean {
  return process.env['SEG_WS_COMPRESSION'] !== 'false';
}
