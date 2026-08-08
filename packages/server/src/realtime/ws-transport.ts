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

  /** When the last outbound batch started, for bytes/sec calculation. */
  private lastWindowStart = 0;
  private readonly totalOutboundBytes = { value: 0 };

  /** Monotonically increasing RTT sample (updated by ping/pong). */
  private smoothedRtt = 0;
  private rttAlpha = 0.125;

  constructor({ socket, id = randomBytes(8).toString('hex') }: WsTransportOptions) {
    this.socket = socket;
    this.id = id;
    this.lastWindowStart = performance.now();

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
    return {
      rttMs: this.smoothedRtt,
      outboundBytesPerSec: this.calcBytesPerSec(),
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
    this.totalOutboundBytes.value += bytes;
  }

  private calcBytesPerSec(): number {
    const now = performance.now();
    const elapsed = now - this.lastWindowStart;
    if (elapsed < 500) return 0; // need at least 500ms for a meaningful rate
    const rate = (this.totalOutboundBytes.value / elapsed) * 1000;
    // Reset window
    this.totalOutboundBytes.value = 0;
    this.lastWindowStart = now;
    return Math.round(rate);
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
