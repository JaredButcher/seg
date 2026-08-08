import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { PROTOCOL_VERSION, SIM_TICK_HZ } from '@seg/shared';

import { initPasswordHashing } from './auth/password.js';
import { AuthService } from './auth/service.js';
import type { ServerConfig } from './config.js';
import { type Db, openDatabase, type Repositories } from './db/index.js';
import { registerAuthRoutes, toErrorBody } from './http/routes/auth.js';
import { Router } from './http/router.js';
import { sendJson } from './http/util.js';
import { LobbyHandler } from './lobby/handler.js';
import { LobbyService } from './lobby/service.js';
import { mountGateway, type Gateway } from './realtime/gateway.js';

export interface App {
  readonly server: Server;
  readonly db: Db;
  readonly repos: Repositories;
  readonly auth: AuthService;
  readonly lobbies: LobbyService;
  readonly gateway: Gateway;
  close(): Promise<void>;
}

export interface CreateAppOptions {
  readonly config: ServerConfig;
  /** Injected by tests so time can be controlled without sleeping. */
  readonly clock?: () => number;
}

export async function createApp(options: CreateAppOptions): Promise<App> {
  const { config } = options;
  const clock = options.clock ?? (() => Date.now());

  const { db, repos } = await openDatabase(config.databaseFile);
  await initPasswordHashing();

  const auth = new AuthService(repos);
  const startedAt = clock();

  const router = new Router();

  router.get('/health', (_req, res) => {
    sendJson(res, 200, {
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      simTickHz: SIM_TICK_HZ,
      uptimeSeconds: Math.floor((clock() - startedAt) / 1000),
    });
  });

  registerAuthRoutes(router, {
    auth,
    secureCookies: config.secureCookies,
    trustProxy: config.trustProxy,
    clock,
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(router, req, res);
  });

  // Lobbies live in memory and die with the process (planning/07 §4).
  const lobbies = new LobbyService({ clock });
  const lobbyHandler = new LobbyHandler(lobbies);
  const gateway = mountGateway({ server, auth, lobby: lobbyHandler, clock });

  // Expired sessions are removed lazily on use; this catches the ones nobody comes back
  // for. `unref` so the timer never keeps the process alive.
  const sweepTimer = setInterval(() => {
    void auth.sweep(clock()).catch(() => undefined);
  }, 60 * 60_000);
  sweepTimer.unref();

  return {
    server,
    db,
    repos,
    auth,
    lobbies,
    gateway,
    async close() {
      clearInterval(sweepTimer);
      await gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}

async function handle(router: Router, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    sendJson(res, 400, { error: { code: 'bad_request', message: 'Malformed URL.' } });
    return;
  }

  const match = router.match(req.method ?? 'GET', url.pathname);

  if (match === null) {
    sendJson(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
    return;
  }
  if (match === 'method_not_allowed') {
    sendJson(res, 405, { error: { code: 'bad_request', message: 'Method not allowed.' } });
    return;
  }

  try {
    await match(req, res, url);
  } catch (err) {
    const { status, body } = toErrorBody(err);
    if (status >= 500) console.error('[seg] unhandled error', err);
    if (!res.headersSent) sendJson(res, status, body);
    else res.end();
  }
}
