import { describe, expect, it } from 'vitest';

import {
  createPong,
  createPing,
  createWelcome,
  type ClientMessage,
  type Envelope,
  type Message,
  type ServerMessage,
  PROTOCOL_VERSION,
  SIM_TICK_HZ,
  ACOUSTIC_TICK_HZ,
} from '../src/index.js';

describe('protocol/schema', () => {
  describe('constants', () => {
    it('exposes the protocol version', () => {
      expect(PROTOCOL_VERSION).toBe(7);
    });

    it('exposes the tick rates', () => {
      expect(SIM_TICK_HZ).toBe(20);
      expect(ACOUSTIC_TICK_HZ).toBe(10);
    });
  });

  describe('message construction', () => {
    it('creates a ping message', () => {
      const ping = createPing(1234);
      expect(ping).toEqual({ t: 'ping', clientTime: 1234 });
    });

    it('creates a pong message', () => {
      const pong = createPong(1000, 1050);
      expect(pong).toEqual({ t: 'pong', clientTime: 1000, serverTime: 1050 });
    });

    it('creates a welcome message', () => {
      const welcome = createWelcome(1, 'abc123');
      expect(welcome).toEqual({ t: 'welcome', protocolVersion: 1, contentHash: 'abc123' });
    });
  });

  describe('type safety', () => {
    it('ping is a valid ClientMessage', () => {
      const ping: ClientMessage = createPing(0);
      expect(ping.t).toBe('ping');
    });

    it('pong is a valid ServerMessage', () => {
      const pong: ServerMessage = createPong(0, 0);
      expect(pong.t).toBe('pong');
    });

    it('welcome is a valid ServerMessage', () => {
      const welcome: ServerMessage = createWelcome(1, 'hash');
      expect(welcome.t).toBe('welcome');
    });

    it('all messages are valid Envelopes', () => {
      const ping: Envelope = createPing(0);
      const pong: Envelope = createPong(0, 0);
      const welcome: Envelope = createWelcome(1, 'hash');

      expect('t' in ping).toBe(true);
      expect('t' in pong).toBe(true);
      expect('t' in welcome).toBe(true);
    });

    it('all messages are valid Messages', () => {
      const ping: Message = createPing(0);
      const pong: Message = createPong(0, 0);
      const welcome: Message = createWelcome(1, 'hash');

      expect('t' in ping).toBe(true);
      expect('t' in pong).toBe(true);
      expect('t' in welcome).toBe(true);
    });

    it('discriminates ping from pong by type tag', () => {
      const ping: Message = createPing(0);
      const pong: Message = createPong(0, 0);

      if (ping.t === 'ping') {
        expect('clientTime' in ping).toBe(true);
      }
      if (pong.t === 'pong') {
        expect('serverTime' in pong).toBe(true);
      }
    });
  });

  describe('ping message shape', () => {
    it('has exactly the required fields', () => {
      const ping = createPing(42);
      expect(Object.keys(ping).sort()).toEqual(['clientTime', 't']);
    });

    it('accepts any numeric timestamp', () => {
      expect(createPing(0).clientTime).toBe(0);
      expect(createPing(1_700_000_000_000).clientTime).toBe(1_700_000_000_000);
      expect(createPing(-100).clientTime).toBe(-100);
    });
  });

  describe('pong message shape', () => {
    it('has exactly the required fields', () => {
      const pong = createPong(100, 200);
      expect(Object.keys(pong).sort()).toEqual(['clientTime', 'serverTime', 't']);
    });

    it('preserves both timestamps', () => {
      const pong = createPong(500, 523);
      expect(pong.clientTime).toBe(500);
      expect(pong.serverTime).toBe(523);
    });
  });

  describe('welcome message shape', () => {
    it('has exactly the required fields', () => {
      const welcome = createWelcome(1, 'sha256hash');
      expect(Object.keys(welcome).sort()).toEqual(['contentHash', 'protocolVersion', 't']);
    });

    it('accepts any protocol version', () => {
      expect(createWelcome(1, 'h').protocolVersion).toBe(1);
      expect(createWelcome(42, 'h').protocolVersion).toBe(42);
    });

    it('accepts any content hash string', () => {
      expect(createWelcome(1, '').contentHash).toBe('');
      expect(createWelcome(1, 'a'.repeat(64)).contentHash).toBe('a'.repeat(64));
    });
  });
});
