import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { PROTOCOL_VERSION, SIM_TICK_HZ } from '@seg/shared';

import { initPasswordHashing } from './auth/password.js';
import { AuthService } from './auth/service.js';
import type { ServerConfig } from './config.js';
import { type Db, openDatabase, type Repositories } from './db/index.js';
import { registerAuthRoutes, toErrorBody } from './http/routes/auth.js';
import { registerFleetRoutes, toFleet } from './http/routes/fleets.js';
import { Router } from './http/router.js';
import { sendJson } from './http/util.js';
import { LobbyHandler } from './lobby/handler.js';
import { LobbyService } from './lobby/service.js';
import { createMatchStarter, MatchHandler, MatchPool, MatchStore } from './match/index.js';
import { ConnectionRegistry } from './realtime/connections.js';
import { mountGateway, type Gateway } from './realtime/gateway.js';

export interface App {
  readonly server: Server;
  readonly db: Db;
  readonly repos: Repositories;
  readonly auth: AuthService;
  readonly lobbies: LobbyService;
  readonly matchStore: MatchStore;
  readonly matches: MatchHandler;
  /** The worker threads running matches, and the cap on how many there may be. */
  readonly matchPool: MatchPool;
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

  // Lobbies live in memory and die with the process (planning/07 §4). Built before the
  // routes because the fleet routes notify it: a fleet edited after being selected has to be
  // re-checked against the lobby's point budget.
  const lobbies = new LobbyService({ clock });

  // One registry, two handlers. A chat line and a roster change have to reach the same
  // sockets, and two maps of the same thing drift the first time one forgets a detach.
  const connections = new ConnectionRegistry();

  // Matches live on worker threads, one each, capped by configuration (planning/01 §1). The pool
  // owns the threads; the store owns what this thread is allowed to know about them.
  const matchPool = new MatchPool({ limit: config.maxConcurrentMatches });
  const matchStore = new MatchStore({ pool: matchPool, connections });

  const matchHandler = new MatchHandler({ store: matchStore, connections, clock });

  // The simulation no longer has a timer here: each match carries its own, on its own thread
  // (`match/worker/entry.ts`). What this thread does instead is listen — a match announces its own
  // end rather than being polled for one, which is what let the 20 Hz clock that walked every match
  // go away entirely.
  matchStore.onConcluded((matchId, results) => {
    matchHandler.conclude(matchId, results);
  });
  // A thread that died with no results to show. There is nothing to salvage — the only copy of the
  // state was in that isolate — so the players are told the match is gone rather than left on a HUD
  // that quietly stopped updating.
  matchStore.onLost((matchId) => {
    matchHandler.lost(matchId);
  });

  const startMatch = createMatchStarter({
    store: matchStore,
    clock,
    async loadFleet(accountId, fleetId) {
      const row = await repos.fleets.findById(fleetId);
      // Someone else's fleet is not distinguishable from a missing one — see FleetLoader.
      if (row === undefined || row.account_id !== accountId) return [];
      return toFleet(row).boats;
    },
  });

  const lobbyHandler = new LobbyHandler(lobbies, {
    connections,
    async fleets(accountId, fleetId) {
      const row = await repos.fleets.findById(fleetId);
      // Someone else's fleet is indistinguishable from a missing one — see LobbyFleetLookup.
      if (row === undefined || row.account_id !== accountId) return null;
      // `points` and `boat_count` are recomputed from the shared `fleetCost` on every write,
      // so the budget is checked against the same number the editor showed.
      return { id: row.id, name: row.name, boatCount: row.boat_count, points: row.points };
    },
    /*
     * The composition that keeps the lobby out of the match's business: the starter builds
     * and stores the state, the match handler sends each member their own slice of it, and
     * the lobby is handed back only an id to announce. Nothing the lobby broadcasts has ever
     * held a boat.
     */
    async startMatch(lobby, roster) {
      const state = await startMatch(lobby, roster);
      matchHandler.begin(state.matchId);
      return state.matchId;
    },
    // The other half of the seam above: leaving a lobby mid-match vacates the match seat too,
    // and entering a different one forfeits whatever match the account used to be seated in.
    // Neither callback needs to know which case applies — `MatchHandler` no-ops for an account
    // it has nothing recorded for.
    onMatchDeparture: (accountId) => matchHandler.departed(accountId),
    onEnteredLobby: (accountId) => matchHandler.abandon(accountId),
  });

  registerFleetRoutes(router, {
    auth,
    repos,
    clock,
    onFleetChanged: (accountId, fleetId) => lobbyHandler.fleetChanged(accountId, fleetId),
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(router, req, res);
  });

  const gateway = mountGateway({
    server,
    auth,
    lobby: lobbyHandler,
    match: matchHandler,
    connections,
    clock,
  });

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
    matchStore,
    matches: matchHandler,
    matchPool,
    gateway,
    async close() {
      clearInterval(sweepTimer);
      await gateway.close();
      // Before the socket goes: every match is a thread, and a thread outlives the process's
      // intent to stop unless it is told. planning/10 §7's match-drain window belongs here when it
      // exists — today this is an immediate terminate, which ends matches rather than draining them.
      await matchStore.close();
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
