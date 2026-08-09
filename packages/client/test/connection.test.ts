/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonCodec, createPing, createPong, createWelcome, type Message } from '@seg/shared';

import { Connection } from '../src/net/connection.js';

/**
 * A minimal mock of the WebSocket API that works in jsdom.
 * jsdom provides a WebSocket constructor but it is not functional,
 * so we replace it with a controllable mock.
 */
function createMockWebSocket(url: string) {
  const events: Record<string, ((...args: unknown[]) => void) | undefined> = {};
  let readyState = 0; // CONNECTING
  let _buffer: Uint8Array[] = [];

  const mockWs = {
    url,
    binaryType: 'arraybuffer' as const,

    get readyState() {
      return readyState;
    },

    onopen: null as ((event?: unknown) => void) | null,
    onmessage: null as ((event: { data: ArrayBuffer }) => void) | null,
    onclose: null as ((event: { code: number; reason: string; wasClean: boolean }) => void) | null,
    onerror: null as (() => void) | null,

    send(data: Uint8Array) {
      _buffer.push(new Uint8Array(data));
    },

    get sent() {
      return _buffer;
    },

    clearSent() {
      _buffer = [];
    },

    open() {
      readyState = 1; // OPEN
      this.onopen?.();
    },

    close(code = 1000, reason = '') {
      readyState = 3; // CLOSED
      this.onclose?.({ code, reason, wasClean: true });
    },

    fireEvent(type: string, data: unknown) {
      const handler = events[type];
      if (handler) handler(data);
    },

    onEvent(type: string, handler: (...args: unknown[]) => void) {
      events[type] = handler;
    },
  } as unknown as WebSocket;

  return mockWs;
}

function mockWebSocket(mockWs: WebSocket) {
  const ctor = vi.fn(() => mockWs);
  // A real WebSocket class exposes its readyState constants as statics, and
  // Connection.isOpen compares against WebSocket.OPEN at runtime.
  Object.assign(ctor, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  vi.stubGlobal('WebSocket', ctor);
}

describe('Connection', () => {
  let codec: JsonCodec;
  let mockWs: WebSocket;

  beforeEach(() => {
    codec = new JsonCodec();
    mockWs = createMockWebSocket('ws://localhost:8787');
    mockWebSocket(mockWs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('lifecycle', () => {
    it('starts disconnected', () => {
      const conn = new Connection({ codec });
      expect(conn.state).toBe('disconnected');
      expect(conn.isOpen).toBe(false);
    });

    it('transitions to connected on open', () => {
      const states: string[] = [];
      const conn = new Connection({
        codec,
        onStateChange: (state) => states.push(state),
      });

      conn.connect('ws://localhost:8787');
      expect(states).toContain('connecting');

      mockWs.open();
      expect(states).toContain('connected');
      expect(conn.state).toBe('connected');
      expect(conn.isOpen).toBe(true);
    });

    it('transitions to disconnected on close', () => {
      const states: string[] = [];
      const conn = new Connection({
        codec,
        onStateChange: (state) => states.push(state),
      });

      conn.connect('ws://localhost:8787');
      mockWs.open();
      expect(conn.state).toBe('connected');

      mockWs.close();
      expect(states).toContain('disconnected');
      expect(conn.state).toBe('disconnected');
    });

    it('does not reconnect on error', () => {
      const states: string[] = [];
      const conn = new Connection({
        codec,
        onStateChange: (state) => states.push(state),
      });

      conn.connect('ws://localhost:8787');
      mockWs.open();

      // Error fires, but no close — state stays connected
      mockWs.onerror?.();
      expect(conn.state).toBe('connected');
    });

    it('ignores duplicate connect calls', () => {
      const states: string[] = [];
      const conn = new Connection({
        codec,
        onStateChange: (state) => states.push(state),
      });

      conn.connect('ws://localhost:8787');
      mockWs.open();
      conn.connect('ws://localhost:8787'); // should be ignored

      expect(states.filter((s) => s === 'connecting').length).toBe(1);
    });

    it('disconnects gracefully', () => {
      const states: string[] = [];
      const conn = new Connection({
        codec,
        onStateChange: (state) => states.push(state),
      });

      conn.connect('ws://localhost:8787');
      mockWs.open();
      conn.disconnect();

      expect(conn.state).toBe('disconnected');
    });
  });

  describe('sending', () => {
    it('sends a ping message', () => {
      vi.spyOn(performance, 'now').mockReturnValue(1000);

      const conn = new Connection({ codec });
      conn.connect('ws://localhost:8787');
      mockWs.open();

      conn.sendPing();

      expect(mockWs.sent).toHaveLength(1);
      const decoded = codec.decode(mockWs.sent[0]!) as Message;
      expect(decoded.t).toBe('ping');
      expect((decoded as { clientTime: number }).clientTime).toBe(1000);
    });

    it('sends any message type', () => {
      const conn = new Connection({ codec });
      conn.connect('ws://localhost:8787');
      mockWs.open();

      const ping = createPing(5000);
      conn.send(ping);

      expect(mockWs.sent).toHaveLength(1);
      const decoded = codec.decode(mockWs.sent[0]!) as Message;
      expect(decoded.t).toBe('ping');
    });

    it('throws when sending while disconnected', () => {
      const conn = new Connection({ codec });
      expect(() => conn.send(createPing(0))).toThrow('not open');
    });

    it('throws when sending while connecting', () => {
      const conn = new Connection({ codec });
      conn.connect('ws://localhost:8787');
      // Not yet opened
      expect(() => conn.send(createPing(0))).toThrow('not open');
    });
  });

  describe('receiving', () => {
    it('dispatches welcome messages to onWelcome', () => {
      const welcomeHandler = vi.fn();
      const conn = new Connection({
        codec,
        onWelcome: welcomeHandler,
      });

      conn.connect('ws://localhost:8787');
      mockWs.open();

      // Simulate receiving a welcome message
      const welcome = createWelcome(1, 'abc123');
      const bytes = codec.encode(welcome);
      mockWs.onmessage?.({ data: bytes.buffer as ArrayBuffer });

      expect(welcomeHandler).toHaveBeenCalledWith(welcome);
    });

    it('dispatches pong messages to onPong', () => {
      const pongHandler = vi.fn();
      const conn = new Connection({
        codec,
        onPong: pongHandler,
      });

      conn.connect('ws://localhost:8787');
      mockWs.open();

      const actualPong = createPong(100, 200);
      const bytes = codec.encode(actualPong);
      mockWs.onmessage?.({ data: bytes.buffer as ArrayBuffer });

      expect(pongHandler).toHaveBeenCalledWith(actualPong);
    });

    it('fires the generic onMessage handler for all messages', () => {
      const messageHandler = vi.fn();
      const welcomeHandler = vi.fn();
      const pongHandler = vi.fn();

      const conn = new Connection({
        codec,
        onMessage: messageHandler,
        onWelcome: welcomeHandler,
        onPong: pongHandler,
      });

      conn.connect('ws://localhost:8787');
      mockWs.open();

      const welcome = createWelcome(1, 'hash');
      const bytes = codec.encode(welcome);
      mockWs.onmessage?.({ data: bytes.buffer as ArrayBuffer });

      expect(welcomeHandler).toHaveBeenCalledWith(welcome);
      expect(messageHandler).toHaveBeenCalledWith(welcome);
    });

    it('ignores malformed messages', () => {
      const handler = vi.fn();
      const conn = new Connection({
        codec,
        onMessage: handler,
      });

      conn.connect('ws://localhost:8787');
      mockWs.open();

      // Send garbage data
      const garbage = new TextEncoder().encode('not json');
      mockWs.onmessage?.({ data: garbage.buffer as ArrayBuffer });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('close events', () => {
    it('calls onClose with the close event details', () => {
      const closeHandler = vi.fn();
      const conn = new Connection({
        codec,
        onClose: closeHandler,
      });

      conn.connect('ws://localhost:8787');
      mockWs.open();

      mockWs.close(1000, 'normal close');

      expect(closeHandler).toHaveBeenCalledWith({
        code: 1000,
        reason: 'normal close',
        wasClean: true,
      });
    });
  });

  describe('RTT tracking', () => {
    it('starts with rttMs of 0', () => {
      const conn = new Connection({ codec });
      expect(conn.rttMs).toBe(0);
    });

    it('computes rttMs from the pong clientTime', () => {
      vi.spyOn(performance, 'now').mockReturnValue(2000);
      const conn = new Connection({ codec });
      conn.connect('ws://localhost:8787');
      mockWs.open();

      const pong = createPong(1800, 1900);
      const bytes = codec.encode(pong);
      mockWs.onmessage?.({ data: bytes.buffer as ArrayBuffer });

      expect(conn.rttMs).toBe(200);
      vi.restoreAllMocks();
    });
  });
});
