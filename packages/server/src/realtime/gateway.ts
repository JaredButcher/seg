/**
 * @seg/server/realtime/gateway — the WebSocket entry point.
 *
 * Everything here is on the `control` channel and stays on the WebSocket permanently
 * (planning/02 §3.1, ADR 0001).
 *
 * Authentication happens at the **upgrade**, from the session cookie, before the socket is
 * accepted. The alternative — accept, then wait for an `auth` message — means holding open
 * sockets for unauthenticated peers, which is a free resource-exhaustion lever. The cookie is
 * already there and already `HttpOnly`, so there is nothing to gain by re-inventing it.
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  JsonCodec,
  SESSION_COOKIE,
  type Codec,
  type Message,
  type ServerMessage,
} from '@seg/shared';
import { WebSocketServer, type WebSocket } from 'ws';

import type { AuthService } from '../auth/service.js';
import { readCookie } from '../http/util.js';
import { isLobbyMessage, type LobbyHandler } from '../lobby/handler.js';
import { isMatchMessage, type MatchHandler } from '../match/handler.js';
import { ConnectionRegistry, type PlayerConnection } from './connections.js';
import { registerPingHandler } from './ping-handler.js';
import { WsTransport } from './ws-transport.js';

export const GATEWAY_PATH = '/ws';

export interface GatewayOptions {
  readonly server: Server;
  readonly auth: AuthService;
  readonly lobby: LobbyHandler;
  /** Absent, a connection simply never hears about a match. Useful only in tests. */
  readonly match?: MatchHandler;
  /** Shared with the handlers. Defaults to a private one when nothing else needs it. */
  readonly connections?: ConnectionRegistry;
  readonly codec?: Codec;
  readonly clock?: () => number;
}

export interface Gateway {
  /** Live connections, keyed by account. Exposed for tests and the health endpoint. */
  readonly connectionCount: number;
  close(): Promise<void>;
}

interface LiveConnection extends PlayerConnection {
  readonly transport: WsTransport;
}

export function mountGateway(options: GatewayOptions): Gateway {
  const { server, auth, lobby, match } = options;
  const registry = options.connections ?? new ConnectionRegistry();
  const codec = options.codec ?? new JsonCodec();
  const clock = options.clock ?? (() => Date.now());

  const wss = new WebSocketServer({ noServer: true });
  const connections = new Map<string, LiveConnection>();

  server.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket, head);
  });

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      return reject(socket, 400, 'Bad Request');
    }

    // Refused, not ignored. Registering an `upgrade` listener tells Node that upgrades are
    // handled here, so a request this function returns from without answering leaves the
    // socket open forever — an unauthenticated peer holding a connection, which is exactly
    // what authenticating at the upgrade is meant to prevent. If a second upgrade path is
    // ever added, this is the line that has to become a router.
    if (url.pathname !== GATEWAY_PATH) return reject(socket, 404, 'Not Found');

    const token = readCookie(req, SESSION_COOKIE);
    if (token === undefined) return reject(socket, 401, 'Unauthorized');

    let account: { id: string; username: string };
    try {
      const resolved = await auth.resolveSession(token, clock());
      if (resolved === undefined) return reject(socket, 401, 'Unauthorized');
      account = { id: resolved.account.id, username: resolved.account.username };
    } catch {
      return reject(socket, 500, 'Internal Server Error');
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      accept(ws, account);
    });
  }

  function accept(ws: WebSocket, account: { id: string; username: string }): void {
    // One live socket per account. A second tab replaces the first rather than running
    // beside it: the lobby registry is keyed by account, so two sockets would fight over
    // whose `send` wins and a stale tab could act on a lobby the player has left.
    //
    // The losing tab is *told* before it is closed. A bare close is indistinguishable from
    // the network dropping, and one of these two is the player's own doing — without this
    // message the old tab can only say "connection lost", which is both wrong and alarming.
    const existing = connections.get(account.id);
    if (existing !== undefined) {
      existing.send({ t: 'session.replaced' });
      existing.transport.close('replaced by a newer connection');
    }

    const transport = new WsTransport({ socket: ws });
    const connection: LiveConnection = {
      accountId: account.id,
      username: account.username,
      transport,
      send(message: ServerMessage) {
        transport.send('control', codec.encode(message));
      },
    };

    connections.set(account.id, connection);
    registry.add(connection);
    lobby.attach(connection);
    // After the lobby, so a player who is in a match hears about the match last and the
    // match screen is what they land on. Neither message depends on the other's arrival.
    match?.attach(connection);

    registerPingHandler(transport, codec, clock);

    transport.onMessage((channel, payload) => {
      if (channel !== 'control') return;

      let msg: Message;
      try {
        msg = codec.decode(payload);
      } catch {
        // Malformed → close, do not attempt recovery (planning/01 §8).
        transport.close('invalid message');
        return;
      }

      if (isLobbyMessage(msg)) lobby.handle(connection, msg);
      else if (isMatchMessage(msg)) match?.handle(connection, msg);
      // `ping` is handled by registerPingHandler on its own subscription. Anything else is
      // ignored: an unknown type is a newer client talking, not an attack.
    });

    transport.onClose(() => {
      // Only tear down if this socket is still the account's current one — a replaced
      // connection must not detach the tab that replaced it.
      if (connections.get(account.id) === connection) {
        connections.delete(account.id);
        registry.remove(connection);
        lobby.detach(account.id);
        match?.detach(account.id);
      }
    });
  }

  return {
    get connectionCount() {
      return connections.size;
    },
    async close() {
      for (const connection of connections.values()) {
        connection.transport.close('server shutting down');
      }
      connections.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** Refuse an upgrade with a real HTTP status, rather than dropping the socket silently. */
function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
