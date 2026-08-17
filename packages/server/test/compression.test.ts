/**
 * `permessage-deflate`, over a real socket, measured in bytes actually written to the wire.
 *
 * The one thing that cannot be checked anywhere else. Every other bandwidth measurement in this
 * project counts what the *codec* produced (`@seg/shared/protocol/meter.ts`), and compression
 * happens strictly below that — so as far as the meter, the benchmarks and
 * `netcode-budget.test.ts` are concerned, turning compression on changes nothing at all. What
 * lands on the socket is the only place the 17× is visible.
 *
 * Two things are pinned here, and the second is the one that would rot quietly:
 *
 * 1. That the extension is **negotiated** — an option name typo, or a `ws` upgrade that renames it,
 *    silently gives back an uncompressed connection and a 17× bandwidth regression that no unit
 *    test would notice.
 * 2. That **context takeover is on**. Per-frame deflate is 2.5–6.2×; keeping the window between
 *    messages is what makes it 17–19× (planning/17 §5.2). Somebody optimizing memory could turn it
 *    off in one line, and the only symptom would be the bandwidth bill.
 */

import { deflateRawSync } from 'node:zlib';

import {
  AUTH_ROUTES,
  BinaryCodec,
  JsonCodec,
  type AuthenticatedResponse,
  type Message,
} from '@seg/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { compressionEnabled, deflateOptions } from '../src/realtime/compression.js';
import { api, cookieValue, startTestApp, type TestApp } from './helpers.js';

const GOOD_PASSWORD = 'correct horse battery staple';

let t: TestApp;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  t = await startTestApp();
});

afterEach(async () => {
  for (const socket of openSockets) socket.terminate();
  openSockets.length = 0;
  await t.close();
});

async function account(username: string): Promise<string> {
  const res = await api<AuthenticatedResponse>(t.baseUrl, AUTH_ROUTES.signup, {
    method: 'POST',
    body: { username, password: GOOD_PASSWORD, rememberMe: true },
  });
  return cookieValue(res.setCookie);
}

/**
 * Connect, and report the `Sec-WebSocket-Extensions` header the **server** answered with.
 *
 * Off the upgrade response, and deliberately not off `socket.extensions`: that getter is
 * `Object.keys(this._extensions).join()` and returns the extension *names* with every negotiated
 * parameter stripped, so it reports a bare `permessage-deflate` whatever the window and context
 * settings turned out to be. Asserting on it would have passed for any configuration at all —
 * which is what the first draft of this file did.
 */
function connect(cookie: string, query = ''): Promise<{ socket: WebSocket; extensions: string }> {
  const url = `${t.baseUrl.replace('http://', 'ws://')}/ws${query}`;
  const socket = new WebSocket(url, { headers: { cookie }, perMessageDeflate: true });
  openSockets.push(socket);

  let extensions = '';
  socket.on('upgrade', (res) => {
    extensions = res.headers['sec-websocket-extensions'] ?? '';
  });

  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve({ socket, extensions }));
    socket.on('error', reject);
  });
}

describe('permessage-deflate', () => {
  it('is negotiated on a real connection', async () => {
    const cookie = await account('deflate-on');
    const { extensions } = await connect(cookie);

    expect(extensions).toContain('permessage-deflate');
  });

  it('keeps the compression context between messages', async () => {
    // The 17× lever. `no_context_takeover` in the negotiated extension string is what would say
    // the window is being thrown away after every message — see this file's header.
    const cookie = await account('deflate-ctx');
    const { extensions } = await connect(cookie);

    expect(extensions).not.toContain('server_no_context_takeover');
  });

  it('negotiates the tuned window rather than the 32 KB default', async () => {
    // `windowBits: 13` is 113 KB of zlib state per connection instead of 219 KB
    // (`compression.ts`). At the 160 connections a full box carries, that is 18 MB against 35 —
    // and, under the binary codec, for no measurable loss of compression at all.
    const cookie = await account('deflate-window');
    const { extensions } = await connect(cookie);

    expect(extensions).toContain('server_max_window_bits=13');
  });
});

describe('the options themselves', () => {
  it('turn off completely when asked, because that is the way back', () => {
    // planning/02 §9's rule: every transport-shaped decision keeps a way back. "Is it the
    // compressor" is a question best answered by turning it off.
    expect(deflateOptions(false)).toBe(false);
    expect(deflateOptions(true)).not.toBe(false);
  });

  it('are on by default and off for SEG_WS_COMPRESSION=false', () => {
    const before = process.env['SEG_WS_COMPRESSION'];
    try {
      delete process.env['SEG_WS_COMPRESSION'];
      expect(compressionEnabled()).toBe(true);
      process.env['SEG_WS_COMPRESSION'] = 'false';
      expect(compressionEnabled()).toBe(false);
      process.env['SEG_WS_COMPRESSION'] = 'true';
      expect(compressionEnabled()).toBe(true);
    } finally {
      if (before === undefined) delete process.env['SEG_WS_COMPRESSION'];
      else process.env['SEG_WS_COMPRESSION'] = before;
    }
  });

  it('sit below the smallest view frame and above every control message', () => {
    // The `threshold`. A `pong` is smaller than the deflate block header it would acquire; the
    // smallest view frame measured is ~1.6 KB. 512 is the line between them, and this asserts the
    // *reason* rather than the number — if view frames ever get smaller than the threshold, the
    // compression that the whole budget rests on quietly stops happening to most of them.
    const options = deflateOptions(true);
    expect(options).not.toBe(false);
    if (options === false) return;
    expect(options.threshold).toBeLessThan(1_500);
    expect(options.threshold).toBeGreaterThan(64);
  });
});

describe('what compression is worth on this data', () => {
  it('compresses a view-frame-shaped payload by an order of magnitude', () => {
    // Not a socket test — a sanity check on the *claim*, so that a future reader who doubts the
    // 17× can see where it comes from without running the benchmark. Real numbers, with context
    // takeover across successive frames, are in planning/17 §5.2 and
    // `pnpm --filter @seg/tools bench:netcode:bandwidth`.
    const frame = JSON.stringify({
      t: 'match.view',
      matchId: 'm1',
      seq: 1,
      boats: Array.from({ length: 24 }, (_, i) => ({
        id: i + 1,
        pos: { x: 1234.5 + i, y: 2345.75 - i },
        facing: 1.5707963267948966,
        speed: 7.7166,
        throttle: 'full',
        hp: 110,
        cavitating: false,
        order: { kind: 'transit', waypoints: [{ x: 7360, y: 1500 }] },
        status: 'active',
        activeSonar: false,
        lastPingTick: 0,
        transients: [],
        noiseLevel: 62.5,
      })),
    });

    const raw = Buffer.byteLength(frame);
    const compressed = deflateRawSync(Buffer.from(frame), { level: 1 }).byteLength;

    // Even single-shot, with no window history at all, a frame this repetitive gives back most of
    // itself. The socket does better because the window has seen the previous frame.
    expect(raw / compressed).toBeGreaterThan(5);
  });
});

describe('codec negotiation, over a real socket', () => {
  /** The first message the server sends. `welcome`, by construction (`gateway.ts`). */
  function firstMessage(socket: WebSocket): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      socket.once('message', (data: Buffer) => resolve(new Uint8Array(data)));
      socket.once('error', reject);
      setTimeout(() => reject(new Error('no message within 2s')), 2_000);
    });
  }

  it('speaks JSON to a client that asks for nothing', async () => {
    // The direction that makes the rollout safe: a client predating negotiation asks for nothing
    // and gets exactly what it got before.
    const cookie = await account('codec-default');
    const { socket } = await connect(cookie);
    const welcome = new JsonCodec().decode(await firstMessage(socket)) as Message;

    expect(welcome.t).toBe('welcome');
    expect((welcome as { codec?: string }).codec).toBe('json');
  });

  it('speaks binary to a client that asks for it', async () => {
    const cookie = await account('codec-binary');
    const { socket } = await connect(cookie, '?codec=binary');
    const bytes = await firstMessage(socket);
    const welcome = new BinaryCodec().decode(bytes) as Message;

    expect(welcome.t).toBe('welcome');
    expect((welcome as { codec?: string }).codec).toBe('binary');
  });

  it('downgrades an unrecognized request rather than refusing the connection', async () => {
    // planning/02 §3.2's posture, applied to the codec: fall back rather than fail. A newer client
    // asking for something this build has never heard of still gets a working session.
    const cookie = await account('codec-unknown');
    const { socket } = await connect(cookie, '?codec=protobuf-9000');
    const welcome = new JsonCodec().decode(await firstMessage(socket)) as Message;

    expect((welcome as { codec?: string }).codec).toBe('json');
  });

  it('sends welcome as the very first message on the socket', async () => {
    // It has to be: it is the only place the codec choice is confirmed, and a client that read a
    // lobby message first would have had to decode it without knowing how.
    const cookie = await account('codec-first');
    const { socket } = await connect(cookie, '?codec=binary');
    const welcome = new BinaryCodec().decode(await firstMessage(socket)) as Message;

    expect(welcome.t).toBe('welcome');
  });
});
