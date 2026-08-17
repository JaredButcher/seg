/**
 * A match on a real worker thread, wired to fake sockets — the fixture every match protocol test
 * builds on.
 *
 * ## Why the tests grew an `await`
 *
 * A match runs on its own thread (`match/worker/entry.ts`), so nothing it sends is available on the
 * tick that asked for it. `handler.begin(...)` posts a message and returns; the setup and the first
 * view frame land a turn or two of the event loop later. Every assertion about what a player was
 * sent therefore has to be preceded by `await settle()`.
 *
 * That is real and not an artefact of the fixture: it is the same latency production has, and a
 * test that could assert synchronously would be testing something the server no longer does.
 *
 * ## Why the fake decodes
 *
 * The main thread no longer builds match frames — the worker does, and it sends **bytes** chosen
 * for the codec that recipient negotiated (`realtime/connections.ts#deliver`). A fake connection
 * that only implemented `send` would see chat and rejoin offers and nothing else.
 *
 * So `sendEncoded` decodes with this connection's own codec and pushes the result into the same
 * list `send` writes to. Assertions stay written against `ServerMessage`, which is what they are
 * actually about; the bytes are an implementation detail of how the message got here. It also
 * means a test asserting on `sent` is transitively asserting the frame round-tripped through a
 * real codec, which the old in-process fixture never checked.
 */

import {
  BinaryCodec,
  JsonCodec,
  deployMatch,
  generateMap,
  type BoatTemplate,
  type Codec,
  type CodecId,
  type DeployingPlayer,
  type GameMode,
  type MapType,
  type MatchState,
  type ServerMessage,
} from '@seg/shared';

import { vi } from 'vitest';

import { MatchHandler } from '../src/match/handler.js';
import { MatchStore } from '../src/match/store.js';
import { MatchPool } from '../src/match/worker/pool.js';
import { ConnectionRegistry, type PlayerConnection } from '../src/realtime/connections.js';

/**
 * Every test that imports this file starts at least one worker thread, so every one of them gets
 * longer than vitest's 5 s default.
 *
 * A thread has to boot, register the tsx loader, import `@seg/shared`, and rasterize the acoustic
 * lattice and rock mask before it can answer anything. On an idle box that is a few hundred
 * milliseconds. In a full `vitest run` — where several test files run in parallel and each is
 * starting threads of its own — it is a multiple of that, and the tests that drive sixty ticks
 * through two matches are several seconds even unloaded.
 *
 * Set here rather than in `vitest.config.ts` because importing this harness is exactly the signal
 * that a file needs it, and raising the timeout for the whole repo would hide a hang in the 1600
 * tests that have no threads in them at all.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const CODECS: Readonly<Record<CodecId, Codec>> = {
  json: new JsonCodec(),
  binary: new BinaryCodec(),
};

export const BOAT: BoatTemplate = { name: 'S-01', hull: 'light', modules: [] };

export function seat(
  accountId: string,
  position: DeployingPlayer['position'],
  boats: readonly BoatTemplate[] = [BOAT],
): DeployingPlayer {
  return { accountId, username: accountId, position, boats };
}

export interface MatchFixtureOptions {
  readonly matchId?: string;
  readonly mode?: GameMode;
  readonly mapType?: MapType;
  readonly seed?: number;
  readonly players?: readonly DeployingPlayer[];
  readonly debugMode?: boolean;
}

/** A deployed match, as every fixture in this directory builds one. */
export function match(options: MatchFixtureOptions = {}): MatchState {
  return deployMatch({
    matchId: options.matchId ?? 'm1',
    mode: options.mode ?? 'objective-capture',
    map: generateMap(options.mapType ?? 'empty', {
      seed: options.seed ?? 5,
      mapSize: 'small',
    }),
    startedAt: 1_000,
    ...(options.debugMode === undefined ? {} : { debugMode: options.debugMode }),
    players: options.players ?? [
      seat('host', 'team1'),
      seat('mate', 'team1'),
      seat('foe', 'team2'),
      seat('watcher', 'spectator', []),
    ],
  });
}

export interface Fake extends PlayerConnection {
  readonly sent: ServerMessage[];
  clear(): void;
  /** Every chat line this connection was given, in order. */
  lines(): string[];
  /** The message types this connection has been sent, in order. */
  types(): string[];
  /** The last message of a given type, or `undefined`. */
  last<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }> | undefined;
}

export function fake(accountId: string, codec: CodecId = 'json'): Fake {
  const sent: ServerMessage[] = [];
  return {
    accountId,
    username: accountId,
    codec,
    sent,
    send: (message) => sent.push(message),
    // The decode that keeps assertions readable — see the header.
    sendEncoded: (payload) => sent.push(CODECS[codec].decode(payload) as ServerMessage),
    clear: () => {
      sent.length = 0;
    },
    lines: () =>
      sent.flatMap((message) => (message.t === 'chat.message' ? [message.entry.text] : [])),
    types: () => sent.map((message) => message.t),
    last: <T extends ServerMessage['t']>(type: T) =>
      [...sent].reverse().find((message) => message.t === type) as
        Extract<ServerMessage, { t: T }> | undefined,
  };
}

/**
 * Wait out the event loop, for the handful of places with no thread to synchronise against.
 *
 * **Prefer `fixture.sync()`.** This is a timer wait and it races thread scheduling: turns of
 * `setTimeout(0)` on this thread can all elapse before the worker has been scheduled once, which
 * is not a hypothetical — it is what the first draft of these tests did, and it failed by
 * asserting on an empty inbox while the match ticked happily on the other side.
 *
 * `sync()` round-trips a token through the worker instead, and a port delivers in order, so its
 * answer proves everything posted earlier was handled. Use this one only before a match exists, or
 * after one is gone.
 */
export async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export interface MatchFixture {
  readonly store: MatchStore;
  readonly pool: MatchPool;
  readonly handler: MatchHandler;
  readonly connections: ConnectionRegistry;
  /**
   * Wait until the match's thread has caught up with everything asked of it.
   *
   * The one call every assertion about what a player was sent has to be preceded by. Deterministic
   * rather than timed — see `settle`.
   */
  sync(matchId?: string): Promise<void>;
  /** Advance the match one sim tick. The pool is unscheduled, so nothing moves without this. */
  tick(matchId?: string): Promise<void>;
  /** Advance `count` ticks, then wait for all of them. */
  ticks(count: number, matchId?: string): Promise<void>;
  /** Set `now`, which the handler reads for chat timestamps and rate limiting. */
  setNow(at: number): void;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** How many matches may run at once. Small by default — a test that needs 33 says so. */
  readonly limit?: number;
  readonly clock?: () => number;
}

/**
 * Build the whole main-thread side: a pool, a store, a handler, and a connection registry.
 *
 * **Unscheduled.** `intervalMs: null` means the worker arms no timer and the match advances only
 * when a test calls `tick()`. That is the same bargain `MatchRuntime`'s own tests have always had
 * — drive the loop by hand, never sleep (planning/13 §13) — carried across the thread boundary.
 */
export function harness(options: HarnessOptions = {}): MatchFixture {
  let now = 10_000;
  const connections = new ConnectionRegistry();
  const pool = new MatchPool({
    limit: options.limit ?? 4,
    intervalMs: null,
    // A coarse lattice, as every match test in this directory uses: building the real one costs
    // more than the whole rest of the suite (`MatchRuntimeOptions`).
    runtimeOptions: { cellSize: 60, collisionCell: 60 },
  });
  const store = new MatchStore({ pool, connections });
  const handler = new MatchHandler({
    store,
    connections,
    clock: options.clock ?? (() => now),
  });
  store.onConcluded((matchId, results) => {
    handler.conclude(matchId, results);
  });
  store.onLost((matchId) => {
    handler.lost(matchId);
  });

  return {
    store,
    pool,
    handler,
    connections,
    async sync(matchId = 'm1') {
      await store.sync(matchId);
    },
    async tick(matchId = 'm1') {
      store.step(matchId);
      await store.sync(matchId);
    },
    async ticks(count, matchId = 'm1') {
      for (let i = 0; i < count; i += 1) store.step(matchId);
      await store.sync(matchId);
    },
    setNow(at) {
      now = at;
    },
    async close() {
      await store.close();
    },
  };
}
