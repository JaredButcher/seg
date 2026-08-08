/**
 * @seg/shared/protocol — wire message schema and codec.
 *
 * Every message is a discriminated union on `t` (type tag). This is the single source of
 * truth for both the server and the client, so encode/decode cannot drift (planning/02 §4).
 *
 * The three-layer discipline:
 *   game code ──► Messages (typed, schema'd)
 *                Codec   ──► Uint8Array
 *                Transport ──► the network
 *
 * Game code never sees bytes; the transport never sees messages. The codec is the only
 * place that knows both.
 */

// ── Channels ──────────────────────────────────────────────────────────────────────────

/**
 * Three logical channels, distinguished by delivery requirements.
 * Under WebSocket all three are multiplexed over one reliable ordered socket (planning/02 §3).
 */
export type ChannelId = 'control' | 'commands' | 'view';

// ── Message types ─────────────────────────────────────────────────────────────────────

/** Base envelope for every message on the wire. */
export interface Envelope {
  readonly t: string;
}

// ── client → server ───────────────────────────────────────────────────────────────────

export interface PingMessage extends Envelope {
  readonly t: 'ping';
  readonly clientTime: number;
}

// ── server → client ───────────────────────────────────────────────────────────────────

export interface PongMessage extends Envelope {
  readonly t: 'pong';
  readonly clientTime: number;
  readonly serverTime: number;
}

/** Handshake: server → client, sent immediately after the WebSocket opens. */
export interface WelcomeMessage extends Envelope {
  readonly t: 'welcome';
  readonly protocolVersion: number;
  readonly contentHash: string;
}

// ── Union types ───────────────────────────────────────────────────────────────────────

/** Every client-to-server message. */
export type ClientMessage = PingMessage;

/** Every server-to-client message. */
export type ServerMessage = PongMessage | WelcomeMessage;

/** Any message on the wire. */
export type Message = ClientMessage | ServerMessage;

// ── Codec ─────────────────────────────────────────────────────────────────────────────

/**
 * Serializes and deserializes messages to/from byte buffers.
 *
 * The critical discipline: game code never sees bytes, and the transport never sees
 * messages. The codec is the only place that knows both (planning/02 §2).
 */
export interface Codec {
  /** Encode a message to bytes. */
  encode<T extends Message>(msg: T): Uint8Array;
  /** Decode bytes to a message. Throws on invalid input. */
  decode(bytes: Uint8Array): Message;
}

// ── JSON Codec ────────────────────────────────────────────────────────────────────────

/**
 * The JSON codec for the JSON era. It stringifies, TextEncoder-encodes, and
 * reverses. The eventual BinaryCodec will swap in without touching game code.
 */
export class JsonCodec implements Codec {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  encode<T extends Message>(msg: T): Uint8Array {
    return this.encoder.encode(JSON.stringify(msg));
  }

  decode(bytes: Uint8Array): Message {
    const json = this.decoder.decode(bytes);
    if (json.trim() === '') {
      throw new Error('invalid message: empty payload');
    }
    const parsed = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || !('t' in parsed)) {
      throw new Error('invalid message: missing type tag');
    }
    return parsed as Message;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────

/** Create a ping message. */
export function createPing(clientTime: number): PingMessage {
  return { t: 'ping', clientTime };
}

/** Create a pong message. */
export function createPong(clientTime: number, serverTime: number): PongMessage {
  return { t: 'pong', clientTime, serverTime };
}

/** Create a welcome message. */
export function createWelcome(protocolVersion: number, contentHash: string): WelcomeMessage {
  return { t: 'welcome', protocolVersion, contentHash };
}
