/**
 * @seg/shared/protocol/meter — how many bytes went where, and as what.
 *
 * Nothing on the server counts bytes today. `WsTransport` keeps a lifetime total for a stats
 * getter nobody aggregates, and by the time bytes reach a transport the only breakdown left is
 * "bytes" — the message is a `Uint8Array` and its type tag is gone.
 *
 * So the accounting goes **in the codec**, which is the last place that holds both
 * ([planning/17 §4.2](../../../../planning/17-netcode-performance.md)). `CountingCodec` wraps any
 * other codec, so installing it changes no call site, and the same object serves the bandwidth
 * benchmark, the CI budget test, and the dev overlay planning/02 §6 asks for.
 *
 * ## Why bytes are the measurement worth trusting
 *
 * Every timing in this project is worth ±20% on an unpinned dev box and is not comparable across
 * sessions (planning/16 §6). **Byte counts are exact.** For a fixed scenario and seed,
 * `encode(msg).byteLength` is the same number on any machine, this year and next. That is what
 * lets `bench-bandwidth` assert an absolute budget in CI where every other benchmark can only
 * assert a relative regression, and it is why this class exists rather than a sampling profiler.
 *
 * ## Off costs nothing, because off means not constructing one
 *
 * There is no `enabled` flag here, unlike `server/match/perf.ts`. A meter is a wrapper: code that
 * is not measuring holds the plain `JsonCodec` and pays literally nothing — not a branch, not a
 * function call. That is a better zero than a gated counter can manage, and it is available here
 * only because the codec is already an interface with exactly one implementation behind it.
 */

import { channelFor } from './channels.js';
import type { ChannelId, Codec, Message } from './schema.js';

/** What one message type cost, over whatever window the meter has been running. */
export interface WireTally {
  /** The `t` tag. */
  readonly type: string;
  readonly channel: ChannelId;
  readonly messages: number;
  readonly bytes: number;
  /** The largest single encoded message of this type. What a worst case is made of. */
  readonly peak: number;
  /** Mean encoded size, which is `bytes / messages` and is worth not recomputing everywhere. */
  readonly mean: number;
}

/** The whole of what a meter has seen. */
export interface WireTotals {
  readonly messages: number;
  readonly bytes: number;
}

interface Row {
  messages: number;
  bytes: number;
  peak: number;
}

/**
 * A running count of encoded bytes, split by message type.
 *
 * Deliberately **not** a histogram. Percentiles over per-frame sizes are a real requirement of
 * `bench-bandwidth` (planning/17 §3.2 rule 3), but keeping every sample here would make the meter
 * unbounded and therefore unusable in the dev overlay it is also meant to serve. The bench keeps
 * its own samples for the one message type it needs them for; this class stays O(types) forever.
 */
export class WireMeter {
  private readonly rows = new Map<string, Row>();
  private messages = 0;
  private bytes = 0;

  /**
   * Attribute `bytes` to `message`.
   *
   * Takes the message rather than its tag so the channel is derived here — a caller that passed
   * both could pass a pair that disagree, and `channelFor` is the single source of truth for
   * which channel a type belongs on.
   */
  record(message: Message, bytes: number): void {
    this.messages += 1;
    this.bytes += bytes;
    const row = this.rows.get(message.t);
    if (row === undefined) {
      this.rows.set(message.t, { messages: 1, bytes, peak: bytes });
      return;
    }
    row.messages += 1;
    row.bytes += bytes;
    if (bytes > row.peak) row.peak = bytes;
  }

  get totals(): WireTotals {
    return { messages: this.messages, bytes: this.bytes };
  }

  /** Every type seen, heaviest first — which is the order a reader wants to fix things in. */
  tallies(): readonly WireTally[] {
    return [...this.rows]
      .map(([type, row]) => ({
        type,
        channel: channelFor({ t: type } as Message),
        messages: row.messages,
        bytes: row.bytes,
        peak: row.peak,
        mean: row.bytes / row.messages,
      }))
      .sort((a, b) => b.bytes - a.bytes);
  }

  /** Bytes per channel, which is the number planning/02 §6's dev overlay is specified in. */
  byChannel(): Readonly<Record<ChannelId, number>> {
    const out: Record<ChannelId, number> = { control: 0, commands: 0, view: 0 };
    for (const tally of this.tallies()) out[tally.channel] += tally.bytes;
    return out;
  }

  /** How many bytes of one type. Zero for a type never seen, which is not an error. */
  bytesOf(type: string): number {
    return this.rows.get(type)?.bytes ?? 0;
  }

  /** How many messages of one type. */
  countOf(type: string): number {
    return this.rows.get(type)?.messages ?? 0;
  }

  reset(): void {
    this.rows.clear();
    this.messages = 0;
    this.bytes = 0;
  }
}

/**
 * A codec that counts what passes through it, in both directions, and is otherwise the codec it
 * wraps.
 *
 * The two meters are separate because the two directions answer different questions with
 * different limits: outbound is measured against the per-player bandwidth budget (planning/02 §6,
 * 8 KB/s down at p95), inbound against the abuse budget (planning/02 §7), and adding them would
 * produce a number that is not compared to anything.
 */
export class CountingCodec implements Codec {
  constructor(
    private readonly inner: Codec,
    readonly outbound: WireMeter = new WireMeter(),
    readonly inbound: WireMeter = new WireMeter(),
  ) {}

  encode<T extends Message>(msg: T): Uint8Array {
    const bytes = this.inner.encode(msg);
    this.outbound.record(msg, bytes.byteLength);
    return bytes;
  }

  /**
   * Decode, and charge the *encoded* length to the inbound meter.
   *
   * Note it is charged after a successful decode, so a malformed message that throws is not
   * counted. That is the honest reading for a bandwidth figure and the wrong one for an abuse
   * figure — garbage still consumed the link. `bench-inbound` (planning/17 §3.5) measures the
   * reject path on its own for exactly that reason.
   */
  decode(bytes: Uint8Array): Message {
    const message = this.inner.decode(bytes);
    this.inbound.record(message, bytes.byteLength);
    return message;
  }

  reset(): void {
    this.outbound.reset();
    this.inbound.reset();
  }
}
