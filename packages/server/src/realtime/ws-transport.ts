/**
 * @seg/server/realtime/ws-transport — WebSocket transport implementation.
 *
 * Wraps a `ws.WebSocket` instance to conform to the `Transport` interface.
 * All three logical channels are multiplexed over one reliable ordered socket
 * (planning/02 §3). Under WebRTC each would map to a separate data channel.
 */

import { randomBytes } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';

import type {
  ChannelId,
  CloseReason,
  Transport,
  TransportStats,
  Unsubscribe,
} from './transport.js';

/** Maximum inbound message size in bytes. Exceeded → close (planning/02 §7). */
const MAX_MESSAGE_BYTES = 8192;

/**
 * How long the outbound rate window is, ms.
 *
 * Half a second: long enough that a rate computed over it is not dominated by one 10 Hz view
 * frame landing inside it, short enough that the overlay follows a fight.
 */
const RATE_WINDOW_MS = 500;

interface WsTransportOptions {
  /** The underlying WebSocket instance. */
  socket: WebSocket;
  /** Optional unique identifier for this transport (e.g. a connection id). */
  id?: string;
}

export class WsTransport implements Transport {
  private readonly socket: WebSocket;
  private readonly id: string;
  private readonly subscribers = new Set<(channel: ChannelId, payload: Uint8Array) => void>();
  private readonly closeHandlers = new Set<(reason: CloseReason) => void>();
  private closed = false;

  /**
   * The outbound rate window, and the lifetime total beside it.
   *
   * `totalOutboundBytes` is a **lifetime** counter and is never reset — it used to double as the
   * rate window's accumulator, which meant *reading* `stats` cleared it and two readers silently
   * got two wrong answers (planning/17 §4.2). The rate now has its own accumulator, and rolling
   * the window is idempotent within a window, so reading is safe from anywhere and any number of
   * times.
   */
  private windowStart = 0;
  private windowBytes = 0;
  private lastRate = 0;
  private readonly totalOutboundBytes = { value: 0 };

  /** Monotonically increasing RTT sample (updated by ping/pong). */
  private smoothedRtt = 0;
  private rttAlpha = 0.125;

  constructor({ socket, id = randomBytes(8).toString('hex') }: WsTransportOptions) {
    this.socket = socket;
    this.id = id;
    this.windowStart = performance.now();

    socket.binaryType = 'arraybuffer';

    // `ws.WebSocket` is an EventEmitter; the browser-style `onmessage`/`onclose`
    // property assignments do not work with the `ws` package.
    socket.on('message', (data) => {
      if (this.closed) return;
      this.handleInbound(data);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      this.closed = true;
      this.emitClose({ code, message: reason.toString() || 'connection closed' });
    });

    socket.on('error', () => {
      // ws emits 'error' before 'close' on fatal errors. If close never fires,
      // we still need to clean up.
      if (!this.closed && socket.readyState !== WebSocket.OPEN) {
        this.closed = true;
        this.emitClose({ code: 1006, message: 'abnormal closure' });
      }
    });
  }

  // ── Transport interface ────────────────────────────────────────────────────────

  send(_channel: ChannelId, payload: Uint8Array): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(payload);
    this.trackOutbound(payload.byteLength);
  }

  onMessage(handler: (channel: ChannelId, payload: Uint8Array) => void): Unsubscribe {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  onClose(handler: (reason: CloseReason) => void): Unsubscribe {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(1000, reason);
  }

  get stats(): TransportStats {
    this.rollWindow();
    return {
      rttMs: this.smoothedRtt,
      outboundBytesPerSec: this.lastRate,
      queuedBytes: this.socket.bufferedAmount,
    };
  }

  // ── Inbound ────────────────────────────────────────────────────────────────────

  private handleInbound(data: RawData): void {
    const bytes = this.toBytes(data);

    if (bytes.byteLength > MAX_MESSAGE_BYTES) {
      this.close('oversized message');
      return;
    }

    // The transport layer does NOT decode messages — game code does that via
    // the codec. Channels are multiplexed at the application layer for now.
    // Each subscriber receives all messages; the game code dispatches by type.
    const channel: ChannelId = 'control';
    for (const handler of this.subscribers) {
      handler(channel, bytes);
    }
  }

  /**
   * Normalize the various `ws` message representations (Buffer, ArrayBuffer, or
   * a fragment array when `binaryType` is 'fragments') into one Uint8Array.
   */
  private toBytes(data: RawData): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (Array.isArray(data)) {
      const length = data.reduce((total, part) => total + part.length, 0);
      const joined = new Uint8Array(length);
      let offset = 0;
      for (const part of data) {
        joined.set(part, offset);
        offset += part.length;
      }
      return joined;
    }
    return new Uint8Array(data);
  }

  // ── Outbound tracking ──────────────────────────────────────────────────────────

  private trackOutbound(bytes: number): void {
    this.rollWindow();
    this.windowBytes += bytes;
    this.totalOutboundBytes.value += bytes;
  }

  /**
   * Close the rate window if it is old enough, and publish what it measured.
   *
   * Called from both the send path and the stats getter, and safe from both: within one window it
   * does nothing at all, so reading the rate twice in a row gives the same number rather than the
   * second reader getting whatever arrived in between.
   *
   * Note what it does *not* do: keep a sample per send. A rate is what the dev overlay wants; the
   * exact per-message accounting lives in `CountingCodec` (`@seg/shared/protocol/meter.ts`),
   * where the message type is still known and the numbers are exact rather than sampled.
   */
  private rollWindow(): void {
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed < RATE_WINDOW_MS) return;
    this.lastRate = Math.round((this.windowBytes / elapsed) * 1000);
    this.windowStart = now;
    this.windowBytes = 0;
  }

  // ── RTT estimation ─────────────────────────────────────────────────────────────

  /**
   * Record an RTT sample from a ping/round-trip measurement.
   * Uses exponential moving average (RFC 6298 simplified).
   */
  updateRtt(sampleMs: number): void {
    if (this.smoothedRtt === 0) {
      this.smoothedRtt = sampleMs;
    } else {
      this.smoothedRtt = this.rttAlpha * sampleMs + (1 - this.rttAlpha) * this.smoothedRtt;
    }
  }

  // ── Close ──────────────────────────────────────────────────────────────────────

  private emitClose(reason: CloseReason): void {
    for (const handler of this.closeHandlers) {
      try {
        handler(reason);
      } catch {
        // Close handlers should not throw — they run in a callback context.
      }
    }
    this.subscribers.clear();
    this.closeHandlers.clear();
  }

  // ── Internal accessors (for testing) ───────────────────────────────────────────

  _getId(): string {
    return this.id;
  }

  _getSocket(): WebSocket {
    return this.socket;
  }

  _isClosed(): boolean {
    return this.closed;
  }

  _getTotalOutboundBytes(): number {
    return this.totalOutboundBytes.value;
  }
}
