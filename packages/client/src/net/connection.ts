/**
 * @seg/client/net/connection — client-side WebSocket connection manager.
 *
 * Wraps the native `WebSocket` API to conform to the `Transport` interface shape
 * that the server's `WsTransport` also implements. The client does not import the
 * server's `Transport` interface (client and server must never depend on each other),
 * so this file declares a compatible local interface.
 *
 * Handles:
 * - Connection lifecycle (open, close, error)
 * - Message dispatch (typed callbacks per message type)
 * - Ping/pong keepalive (planning/02 §5)
 * - Welcome handshake (planning/02 §4)
 */

import type { Codec, Message, PongMessage, WelcomeMessage } from '@seg/shared';
import { createPing } from '@seg/shared';

// ── Types ─────────────────────────────────────────────────────────────────────────────

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface CloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export type MessageHandler<T = Message> = (msg: T) => void;

export interface ConnectionOptions {
  /** The codec for encoding/decoding messages. */
  codec: Codec;
  /** Called when the connection state changes. */
  onStateChange?: (state: ConnectionState) => void;
  /** Called when the connection closes. */
  onClose?: (event: CloseEvent) => void;
  /** Called for any message (untyped). */
  onMessage?: MessageHandler;
  /** Called for welcome messages. */
  onWelcome?: (msg: WelcomeMessage) => void;
  /** Called for pong messages. */
  onPong?: (msg: PongMessage) => void;
}

// ── Connection ────────────────────────────────────────────────────────────────────────

/**
 * Client-side connection to the game server.
 *
 * Manages the WebSocket lifecycle, message encoding/decoding, and
 * ping/pong keepalive. Does not depend on the server package — it
 * only uses `@seg/shared` types and the native WebSocket API.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private _state: ConnectionState = 'disconnected';
  private readonly codec: Codec;
  private readonly onStateChange: ((state: ConnectionState) => void) | undefined;
  private readonly onClose: ((event: CloseEvent) => void) | undefined;
  private readonly onMessage: MessageHandler | undefined;
  private readonly onWelcome: ((msg: WelcomeMessage) => void) | undefined;
  private readonly onPong: ((msg: PongMessage) => void) | undefined;

  /** Round-trip time estimate in ms, updated by ping/pong. */
  public rttMs = 0;

  /** The WebSocket URL. Set before calling connect(). */
  public url = '';

  constructor(options: ConnectionOptions) {
    this.codec = options.codec;
    this.onStateChange = options.onStateChange;
    this.onClose = options.onClose;
    this.onMessage = options.onMessage;
    this.onWelcome = options.onWelcome;
    this.onPong = options.onPong;
  }

  /** Current connection state. */
  get state(): ConnectionState {
    return this._state;
  }

  /** Whether the connection is currently open. */
  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────

  /**
   * Connect to the server at the configured URL.
   * Sends the protocol version and codec preference in the connection URL.
   */
  connect(url: string): void {
    if (this._state === 'connecting' || this._state === 'connected') return;

    this.url = url;
    this._state = 'connecting';
    this.notifyStateChange();

    try {
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this._state = 'connected';
        this.notifyStateChange();
      };

      this.ws.onmessage = (event) => {
        this.handleInbound(event.data);
      };

      this.ws.onclose = (event) => {
        this._state = 'disconnected';
        this.notifyStateChange();
        this.onClose?.({
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
      };

      this.ws.onerror = () => {
        // The 'close' event fires after 'error' if the connection actually closes.
        // If it doesn't, the user can call disconnect().
      };
    } catch {
      this._state = 'disconnected';
      this.notifyStateChange();
    }
  }

  /** Gracefully close the connection. */
  disconnect(reason = 'client disconnect'): void {
    if (this.ws) {
      this.ws.close(1000, reason);
      this.ws = null;
    }
    this._state = 'disconnected';
    this.notifyStateChange();
  }

  // ── Sending ────────────────────────────────────────────────────────────────────

  /**
   * Send a message to the server.
   * Encodes the message via the codec and sends it over the WebSocket.
   * Throws if not connected.
   */
  send<T extends Message>(msg: T): void {
    if (!this.isOpen) {
      throw new Error('cannot send: connection is not open');
    }
    const bytes = this.codec.encode(msg);
    this.ws!.send(bytes);
  }

  /**
   * Send a ping. The server will reply with a pong.
   * The client timestamp becomes the `clientTime` echoed back in the pong,
   * which is how RTT is measured on arrival (planning/02 §5).
   */
  sendPing(): void {
    const clientTime = performance.now();
    this.send(createPing(clientTime));
  }

  // ── Inbound ────────────────────────────────────────────────────────────────────

  private handleInbound(data: ArrayBuffer): void {
    const bytes = new Uint8Array(data);
    let msg: Message;

    try {
      msg = this.codec.decode(bytes);
    } catch {
      // Malformed message — log and ignore.
      return;
    }

    // Dispatch to typed handlers first
    if (msg.t === 'welcome' && this.onWelcome) {
      this.onWelcome(msg as WelcomeMessage);
    }
    if (msg.t === 'pong') {
      const pong = msg as PongMessage;
      // clientTime is the timestamp we stamped when the ping was sent,
      // so (now - clientTime) is the round-trip time.
      this.rttMs = performance.now() - pong.clientTime;
      this.onPong?.(pong);
    }

    // Also fire the generic handler
    this.onMessage?.(msg);
  }

  private notifyStateChange(): void {
    this.onStateChange?.(this._state);
  }
}
