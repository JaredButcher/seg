import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { JsonCodec, createPing } from '@seg/shared';

import type { CloseReason } from '../src/realtime/transport.js';
import { WsTransport } from '../src/realtime/ws-transport.js';

/** A real echo WebSocket server: everything it receives it sends straight back. */
async function createEchoServer(): Promise<{
  server: WebSocketServer;
  port: number;
  close: () => Promise<void>;
}> {
  const server = new WebSocketServer({ port: 0 });
  server.on('connection', (socket) => {
    socket.on('message', (data) => socket.send(data));
  });
  await once(server, 'listening');

  const addr = server.address() as AddressInfo;
  return {
    server,
    port: addr.port,
    close: () => closeServer(server),
  };
}

/** Terminate any live sockets, then close the server. Idempotent. */
async function closeServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Open a real client connection and wrap it in a WsTransport. */
function connectClient(
  port: number,
  id?: string,
): Promise<{ ws: WebSocket; transport: WsTransport }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => {
      resolve({
        ws,
        transport: id ? new WsTransport({ socket: ws, id }) : new WsTransport({ socket: ws }),
      });
    });
    ws.on('error', reject);
  });
}

describe('WsTransport', () => {
  const liveServers: WebSocketServer[] = [];
  const codec = new JsonCodec();

  afterEach(async () => {
    for (const server of liveServers) {
      await closeServer(server);
    }
    liveServers.length = 0;
  });

  async function setupEchoServer(): Promise<{
    server: WebSocketServer;
    port: number;
    close: () => Promise<void>;
  }> {
    const { server, port, close } = await createEchoServer();
    liveServers.push(server);
    return { server, port, close };
  }

  it('sends and receives messages', async () => {
    const { port } = await setupEchoServer();
    const { transport } = await connectClient(port);

    const received: Uint8Array[] = [];
    transport.onMessage((_channel, payload) => {
      received.push(payload);
    });

    const ping = codec.encode(createPing(1000));
    transport.send('control', ping);

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toEqual(ping);
  });

  it('delivers to multiple subscribers', async () => {
    const { port } = await setupEchoServer();
    const { transport } = await connectClient(port);

    const a: Uint8Array[] = [];
    const b: Uint8Array[] = [];
    transport.onMessage((_channel, payload) => a.push(payload));
    transport.onMessage((_channel, payload) => b.push(payload));

    transport.send('control', codec.encode(createPing(7)));

    await vi.waitFor(() => {
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });
  });

  it('unsubscribes a message handler', async () => {
    const { port } = await setupEchoServer();
    const { transport } = await connectClient(port);

    let count = 0;
    const handler = () => {
      count++;
    };
    const unsubscribe = transport.onMessage(handler);

    transport.send('control', codec.encode(createPing(1)));
    await vi.waitFor(() => {
      expect(count).toBe(1);
    });

    unsubscribe();
    transport.send('control', codec.encode(createPing(2)));
    // Give a possible (incorrect) echo time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(count).toBe(1);
  });

  it('calls onClose when the server closes the connection', async () => {
    const { server, port } = await setupEchoServer();
    const { transport } = await connectClient(port);

    const closePromise = new Promise<CloseReason>((resolve) => transport.onClose(resolve));

    const serverSocket = server.clients.values().next().value as WebSocket | undefined;
    expect(serverSocket).toBeDefined();
    serverSocket!.terminate();

    const reason = await closePromise;
    expect(reason.code).toBe(1006);
  });

  it('closes the connection on an oversized inbound message', async () => {
    const { port } = await setupEchoServer();
    const { ws, transport } = await connectClient(port);

    const closePromise = new Promise<CloseReason>((resolve) => transport.onClose(resolve));

    ws.emit('message', new Uint8Array(8193)); // MAX_MESSAGE_BYTES is 8192

    const reason = await closePromise;
    expect(reason.message).toBe('oversized message');
  });

  it('is a no-op to send after close', async () => {
    const { port } = await setupEchoServer();
    const { transport } = await connectClient(port);

    transport.close();
    expect(transport._isClosed()).toBe(true);
    expect(() => transport.send('control', new Uint8Array([1]))).not.toThrow();
  });

  it('does not process inbound messages after close', async () => {
    const { port } = await setupEchoServer();
    const { ws, transport } = await connectClient(port);

    let msgCount = 0;
    transport.onMessage(() => {
      msgCount++;
    });

    transport.close();
    ws.emit('message', codec.encode(createPing(1)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(msgCount).toBe(0);
  });

  it('tracks outbound bytes', async () => {
    const { port } = await setupEchoServer();
    const { transport } = await connectClient(port);

    transport.send('control', new Uint8Array([1, 2, 3, 4, 5]));
    expect(transport._getTotalOutboundBytes()).toBe(5);
  });

  it('generates a random id when not provided', async () => {
    const { port } = await setupEchoServer();
    const { transport } = await connectClient(port);

    expect(transport._getId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('accepts an explicit id', async () => {
    const { port } = await setupEchoServer();
    const { transport } = await connectClient(port, 'explicit-id-123');

    expect(transport._getId()).toBe('explicit-id-123');
  });

  it('provides stats', async () => {
    const { port } = await setupEchoServer();
    const { transport } = await connectClient(port);

    const stats = transport.stats;
    expect(typeof stats.rttMs).toBe('number');
    expect(typeof stats.outboundBytesPerSec).toBe('number');
    expect(typeof stats.queuedBytes).toBe('number');
  });

  it('updates RTT via updateRtt', async () => {
    const { port } = await setupEchoServer();
    const { transport } = await connectClient(port);

    expect(transport.stats.rttMs).toBe(0);

    transport.updateRtt(50);
    expect(transport.stats.rttMs).toBe(50);

    // Second sample is an EMA of the first, so it must land strictly between.
    transport.updateRtt(100);
    const rtt2 = transport.stats.rttMs;
    expect(rtt2).toBeGreaterThan(50);
    expect(rtt2).toBeLessThan(100);
  });
});
