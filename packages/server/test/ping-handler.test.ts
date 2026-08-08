import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { JsonCodec, createPing, type Message } from '@seg/shared';

import { registerPingHandler } from '../src/realtime/ping-handler.js';
import { WsTransport } from '../src/realtime/ws-transport.js';

/** Server side: wrap every incoming socket in a WsTransport with the ping handler wired. */
async function startPingServer(now: () => number): Promise<{
  server: WebSocketServer;
  port: number;
  transports: Set<WsTransport>;
  close: () => Promise<void>;
}> {
  const server = new WebSocketServer({ port: 0 });
  const transports = new Set<WsTransport>();
  const codec = new JsonCodec();

  server.on('connection', (socket) => {
    const transport = new WsTransport({ socket });
    registerPingHandler(transport, codec, now);
    transports.add(transport);
    transport.onClose(() => transports.delete(transport));
  });

  await once(server, 'listening');

  const addr = server.address() as AddressInfo;
  return {
    server,
    port: addr.port,
    transports,
    close: async () => {
      for (const client of server.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Open a real client socket to the test server. */
function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function toBytes(data: RawData): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

describe('registerPingHandler', () => {
  const liveServers: WebSocketServer[] = [];
  const codec = new JsonCodec();

  afterEach(async () => {
    for (const server of liveServers) {
      for (const client of server.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    liveServers.length = 0;
  });

  async function setup(now: () => number): Promise<{
    port: number;
    transports: Set<WsTransport>;
    close: () => Promise<void>;
  }> {
    const { server, port, transports, close } = await startPingServer(now);
    liveServers.push(server);
    return { port, transports, close };
  }

  it('responds to a ping with a pong', async () => {
    const { port, close } = await setup(() => 1_000_000);
    const ws = await connectClient(port);

    const pongPromise = new Promise<Message>((resolve) => {
      ws.on('message', (data: RawData) => resolve(codec.decode(toBytes(data))));
    });

    ws.send(codec.encode(createPing(5000)));

    const pong = await pongPromise;
    expect(pong.t).toBe('pong');
    expect((pong as { clientTime: number }).clientTime).toBe(5000);
    expect((pong as { serverTime: number }).serverTime).toBe(1_000_000);

    await close();
  });

  it('preserves client timestamps across multiple pings', async () => {
    const { port, close } = await setup(() => 2_000_000);
    const ws = await connectClient(port);

    const pongs: Message[] = [];
    ws.on('message', (data: RawData) => {
      pongs.push(codec.decode(toBytes(data)));
    });

    ws.send(codec.encode(createPing(100)));
    ws.send(codec.encode(createPing(200)));
    ws.send(codec.encode(createPing(300)));

    await vi.waitFor(() => {
      expect(pongs.filter((m) => m.t === 'pong')).toHaveLength(3);
    });

    const times = pongs
      .filter((m) => m.t === 'pong')
      .map((m) => (m as { clientTime: number }).clientTime)
      .sort();
    expect(times).toEqual([100, 200, 300]);

    await close();
  });

  it('updates the transport RTT estimate', async () => {
    const { port, transports, close } = await setup(() => 1_000_000);
    const ws = await connectClient(port);

    const serverTransport = transports.values().next().value as WsTransport | undefined;
    expect(serverTransport).toBeDefined();
    expect(serverTransport!.stats.rttMs).toBe(0);

    ws.send(codec.encode(createPing(999_500)));

    // serverTime - clientTime = 500
    await vi.waitFor(() => {
      expect(serverTransport!.stats.rttMs).toBe(500);
    });

    await close();
  });

  it('closes the connection on a malformed control message', async () => {
    const { port, close } = await setup(() => 0);
    const ws = await connectClient(port);

    const closedPromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code: number, reason: Buffer) =>
        resolve({ code, reason: reason.toString() }),
      );
    });

    ws.send(new TextEncoder().encode('not json'));

    const result = await closedPromise;
    expect(result.code).toBe(1000);
    expect(result.reason).toBe('invalid message');

    await close();
  });

  it('ignores valid but non-ping messages', async () => {
    const { port, close } = await setup(() => 0);
    const ws = await connectClient(port);

    ws.send(new TextEncoder().encode(JSON.stringify({ t: 'something-else' })));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(ws.readyState).toBe(WebSocket.OPEN);

    await close();
  });

  it('ignores messages on non-control channels', () => {
    const sent: Uint8Array[] = [];
    let handler: ((channel: 'control' | 'commands' | 'view', payload: Uint8Array) => void) | null =
      null;

    const transport = {
      send: (_channel: 'control' | 'commands' | 'view', payload: Uint8Array) => {
        sent.push(payload);
      },
      onMessage: (h: (channel: 'control' | 'commands' | 'view', payload: Uint8Array) => void) => {
        handler = h;
        return () => {};
      },
      onClose: () => () => {},
      close: () => {},
      get stats() {
        return { rttMs: 0, outboundBytesPerSec: 0, queuedBytes: 0 };
      },
    };

    registerPingHandler(transport, codec, () => 1_000_000);
    handler!('commands', codec.encode(createPing(42)));
    expect(sent).toHaveLength(0);
  });
});
