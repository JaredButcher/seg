/**
 * @seg/server/realtime/transport — the Transport interface.
 *
 * This is the seam that lets us swap WebSocket for WebRTC without touching game code
 * (planning/01 §4.1, planning/02 §9).
 */

export type ChannelId = 'control' | 'commands' | 'view';

export interface CloseReason {
  readonly code: number;
  readonly message: string;
}

export type Unsubscribe = () => void;

export interface TransportStats {
  readonly rttMs: number;
  readonly outboundBytesPerSec: number;
  readonly queuedBytes: number;
}

/**
 * Abstract transport layer.
 *
 * Game code sends and receives `Uint8Array` payloads on named channels.
 * The codec sits between game code and transport: it converts messages to bytes
 * and bytes to messages. Neither side knows about the other.
 */
export interface Transport {
  /** Send bytes on a channel. */
  send(channel: ChannelId, payload: Uint8Array): void;
  /** Register a handler for incoming messages. Returns an unsubscribe function. */
  onMessage(handler: (channel: ChannelId, payload: Uint8Array) => void): Unsubscribe;
  /** Register a handler for connection close. Returns an unsubscribe function. */
  onClose(handler: (reason: CloseReason) => void): Unsubscribe;
  /** Close the transport. */
  close(reason?: string): void;
  /** Current transport statistics. */
  readonly stats: TransportStats;
}
