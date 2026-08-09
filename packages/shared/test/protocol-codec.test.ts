import { beforeEach, describe, expect, it } from 'vitest';

import { JsonCodec, createPing, createPong, createWelcome } from '../src/index.js';

describe('JsonCodec', () => {
  let codec: JsonCodec;

  beforeEach(() => {
    codec = new JsonCodec();
  });

  describe('encode', () => {
    it('encodes a ping message to bytes', () => {
      const msg = createPing(1234);
      const bytes = codec.encode(msg);

      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.byteLength).toBeGreaterThan(0);
    });

    it('encodes a pong message to bytes', () => {
      const msg = createPong(1000, 1050);
      const bytes = codec.encode(msg);

      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.byteLength).toBeGreaterThan(0);
    });

    it('encodes a welcome message to bytes', () => {
      const msg = createWelcome(1, 'abc123');
      const bytes = codec.encode(msg);

      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.byteLength).toBeGreaterThan(0);
    });

    it('produces valid JSON text when decoded', () => {
      const decoder = new TextDecoder();
      const msg = createPing(42);
      const json = decoder.decode(codec.encode(msg));
      const parsed = JSON.parse(json);

      expect(parsed).toEqual({ t: 'ping', clientTime: 42 });
    });
  });

  describe('decode', () => {
    it('decodes a ping message', () => {
      const msg = createPing(999);
      const bytes = codec.encode(msg);
      const decoded = codec.decode(bytes);

      expect(decoded.t).toBe('ping');
      expect((decoded as { clientTime: number }).clientTime).toBe(999);
    });

    it('decodes a pong message', () => {
      const msg = createPong(100, 200);
      const bytes = codec.encode(msg);
      const decoded = codec.decode(bytes);

      expect(decoded.t).toBe('pong');
      expect((decoded as { clientTime: number; serverTime: number }).clientTime).toBe(100);
      expect((decoded as { clientTime: number; serverTime: number }).serverTime).toBe(200);
    });

    it('decodes a welcome message', () => {
      const msg = createWelcome(1, 'sha256');
      const bytes = codec.encode(msg);
      const decoded = codec.decode(bytes);

      expect(decoded.t).toBe('welcome');
      expect((decoded as { protocolVersion: number }).protocolVersion).toBe(1);
      expect((decoded as { contentHash: string }).contentHash).toBe('sha256');
    });

    it('rejects an empty buffer', () => {
      expect(() => codec.decode(new Uint8Array())).toThrow('empty payload');
    });

    it('rejects a buffer without a type tag', () => {
      const withoutType = new TextEncoder().encode(JSON.stringify({ foo: 'bar' }));
      expect(() => codec.decode(withoutType)).toThrow('missing type tag');
    });

    it('rejects a null buffer', () => {
      const nullBytes = new TextEncoder().encode('null');
      expect(() => codec.decode(nullBytes)).toThrow();
    });

    it('rejects a non-object JSON value', () => {
      const strBytes = new TextEncoder().encode('"hello"');
      expect(() => codec.decode(strBytes)).toThrow();
    });
  });

  describe('round-trip', () => {
    it('ping → encode → decode produces the same message', () => {
      const original = createPing(54321);
      const decoded = codec.decode(codec.encode(original));

      expect(decoded.t).toBe(original.t);
      expect((decoded as { clientTime: number }).clientTime).toBe(original.clientTime);
    });

    it('pong → encode → decode produces the same message', () => {
      const original = createPong(1000, 1055);
      const decoded = codec.decode(codec.encode(original));

      expect(decoded.t).toBe(original.t);
      expect((decoded as { clientTime: number; serverTime: number }).clientTime).toBe(1000);
      expect((decoded as { clientTime: number; serverTime: number }).serverTime).toBe(1055);
    });

    it('welcome → encode → decode produces the same message', () => {
      const original = createWelcome(42, 'content-hash-xyz');
      const decoded = codec.decode(codec.encode(original));

      expect(decoded.t).toBe(original.t);
      expect((decoded as { protocolVersion: number }).protocolVersion).toBe(42);
      expect((decoded as { contentHash: string }).contentHash).toBe('content-hash-xyz');
    });
  });

  describe('edge cases', () => {
    it('handles zero timestamps', () => {
      const ping = createPing(0);
      const decoded = codec.decode(codec.encode(ping));
      expect((decoded as { clientTime: number }).clientTime).toBe(0);
    });

    it('handles large timestamps', () => {
      const ping = createPing(9_999_999_999_999);
      const decoded = codec.decode(codec.encode(ping));
      expect((decoded as { clientTime: number }).clientTime).toBe(9_999_999_999_999);
    });

    it('handles empty content hash', () => {
      const welcome = createWelcome(1, '');
      const decoded = codec.decode(codec.encode(welcome));
      expect((decoded as { contentHash: string }).contentHash).toBe('');
    });

    it('handles long content hashes', () => {
      const hash = 'a'.repeat(256);
      const welcome = createWelcome(1, hash);
      const decoded = codec.decode(codec.encode(welcome));
      expect((decoded as { contentHash: string }).contentHash).toBe(hash);
    });
  });
});
