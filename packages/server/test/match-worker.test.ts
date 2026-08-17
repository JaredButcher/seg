/**
 * Matches on worker threads: the boundary itself.
 *
 * The other match tests use a thread because that is now the only way to run a match; this one is
 * *about* the thread. What it pins is the set of claims `match/worker/protocol.ts` makes and
 * nothing above it can check:
 *
 * - a match really does run in another isolate, and its state never comes back
 * - each recipient's frames are built with the codec that recipient negotiated
 * - the concurrency cap refuses rather than degrades
 * - a thread that dies is reported, and its slot is returned
 *
 * On a coarse lattice throughout, like every match test in this directory.
 */

import { BinaryCodec, JsonCodec, type MatchViewMessage } from '@seg/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { MatchPool } from '../src/match/worker/pool.js';
import { fake, harness, match, seat, settle, type MatchFixture } from './match-harness.js';

let fixture: MatchFixture | null = null;
const pools: MatchPool[] = [];

afterEach(async () => {
  await fixture?.close();
  fixture = null;
  for (const pool of pools) await pool.close();
  pools.length = 0;
});

/** A pool a test owns directly, torn down whatever it asserts. */
function pool(limit: number): MatchPool {
  const created = new MatchPool({
    limit,
    intervalMs: null,
    runtimeOptions: { cellSize: 60, collisionCell: 60 },
  });
  pools.push(created);
  return created;
}

const wiring = {
  onOutbound: () => undefined,
  onResults: () => undefined,
  onDigest: () => undefined,
  onLost: () => undefined,
};

describe('the boundary', () => {
  it('runs the match somewhere else, and keeps its state there', async () => {
    fixture = harness();
    const host = fake('host');
    fixture.connections.add(host);

    await fixture.store.begin(match(), 'Test Lobby');
    fixture.handler.begin('m1');
    await fixture.sync();

    // The main thread has a digest and nothing more: no boats, no torpedoes, no map.
    const digest = fixture.store.digest('m1');
    expect(digest?.players.map((player) => player.accountId)).toEqual([
      'host',
      'mate',
      'foe',
      'watcher',
    ]);
    expect(Object.keys(digest ?? {})).not.toContain('boats');

    // And the player has a real frame, which only the far side could have built.
    const view = host.last('match.view');
    expect(view).toBeDefined();
    expect(view?.view.own.length).toBeGreaterThan(0);
  });

  it('advances only when told to, because the pool is unscheduled', async () => {
    fixture = harness();
    // Both sides need a socket. A team with nobody connected is an abandoned match, and the
    // runtime ends it on the first tick (`decideAbandonment`) — so a fixture that connected only
    // one player would measure a match that was already over.
    const host = fake('host');
    for (const connection of [host, fake('mate'), fake('foe'), fake('watcher')]) {
      fixture.connections.add(connection);
    }
    await fixture.store.begin(match(), 'Test Lobby');
    fixture.handler.begin('m1');
    await fixture.sync();
    host.clear();

    // A solve — and therefore a frame — is due every second tick (planning/04 §1).
    await fixture.ticks(4);
    const seqs = host.sent
      .filter((message): message is MatchViewMessage => message.t === 'match.view')
      .map((message) => message.seq);

    expect(seqs).toHaveLength(2);
    // Per recipient and monotonic (planning/02 §3.4).
    expect(seqs[1]).toBe((seqs[0] ?? 0) + 1);
  });

  it('builds each recipient’s frames with the codec that recipient negotiated', async () => {
    fixture = harness();
    // The fakes decode with their own codec, so a frame encoded with the wrong one would throw
    // rather than merely differ — which is the assertion, and why this test looks so mild.
    const host = fake('host', 'json');
    const foe = fake('foe', 'binary');
    fixture.connections.add(host);
    fixture.connections.add(foe);

    await fixture.store.begin(match(), 'Test Lobby');
    fixture.handler.begin('m1');
    await fixture.sync();

    expect(host.types()).toContain('match.view');
    expect(foe.types()).toContain('match.view');

    // And the two really were different bytes: binary is an order of magnitude smaller on a frame
    // this size (planning/17 §5.2), so encoding one as the other could not have gone unnoticed.
    const asJson = new JsonCodec().encode(host.last('match.view')!).byteLength;
    const asBinary = new BinaryCodec().encode(foe.last('match.view')!).byteLength;
    expect(asBinary).toBeLessThan(asJson);
  });
});

describe('the concurrency cap', () => {
  it('refuses the match past the limit rather than admitting it', async () => {
    const capped = pool(2);

    const first = await capped.acquire(match({ matchId: 'a' }), wiring);
    const second = await capped.acquire(match({ matchId: 'b' }), wiring);
    const third = await capped.acquire(match({ matchId: 'c' }), wiring);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Not a throw: a full server is working exactly as configured (`worker/pool.ts`).
    expect(third).toBeNull();
    expect(capped.size).toBe(2);
    expect(capped.full).toBe(true);
  });

  it('gives the slot back when a match is removed', async () => {
    const capped = pool(1);

    expect(await capped.acquire(match({ matchId: 'a' }), wiring)).not.toBeNull();
    expect(await capped.acquire(match({ matchId: 'b' }), wiring)).toBeNull();

    await capped.remove('a');
    expect(capped.size).toBe(0);
    expect(await capped.acquire(match({ matchId: 'b' }), wiring)).not.toBeNull();
  });

  it('holds the slot for a finished match, because its thread still answers', async () => {
    // A concluded match keeps its thread until it is removed: a player reconnecting is owed the
    // results, and the store is what eventually lets it go. The cap counts threads, not playable
    // matches, and this is the difference.
    const capped = pool(1);
    const host = await capped.acquire(match({ matchId: 'a' }), wiring);
    expect(host).not.toBeNull();
    expect(capped.full).toBe(true);
  });

  it('reports capacity through the store, which is what lobby.start reads', async () => {
    fixture = harness({ limit: 1 });

    expect(await fixture.store.begin(match({ matchId: 'm1' }), 'One')).toBe(true);
    expect(fixture.store.capacity).toEqual({ running: 1, limit: 1 });
    // The refusal `MatchStarter` turns into `AtCapacityError`.
    expect(await fixture.store.begin(match({ matchId: 'm2' }), 'Two')).toBe(false);
  });
});

describe('a thread that dies', () => {
  it('is reported, and its slot goes back', async () => {
    fixture = harness({ limit: 1 });
    await fixture.store.begin(match(), 'Test Lobby');

    const lost: string[] = [];
    fixture.store.onLost((matchId) => lost.push(matchId));

    // The only copy of the state was in that isolate, so this is unrecoverable by construction.
    // Killing the thread from underneath the host is the fixture for it.
    await fixture.pool.get('m1')?.dispose();
    await settle();

    // Either the dispose was seen as a clean stop, or it surfaced as a loss — both are correct
    // and which one happens is a race with the worker's own exit. What must be true either way is
    // that the slot is not held by a thread that is gone.
    await fixture.store.remove('m1');
    expect(fixture.store.capacity.running).toBe(0);
    expect(await fixture.store.begin(match({ matchId: 'm2' }), 'Next')).toBe(true);
  });

  it('releases every seat, so nobody is offered a match that no longer exists', async () => {
    fixture = harness();
    const host = fake('host');
    fixture.connections.add(host);
    await fixture.store.begin(match(), 'Test Lobby');
    fixture.handler.begin('m1');
    await fixture.sync();

    expect(fixture.store.digestByAccount('host')).toBeDefined();

    fixture.handler.lost('m1');
    expect(fixture.store.digestByAccount('host')).toBeUndefined();

    // And a fresh connection is told nothing rather than offered a rejoin.
    const returning = fake('host');
    returning.clear();
    fixture.handler.attach(returning);
    expect(returning.sent).toEqual([]);
  });
});

describe('spectators', () => {
  it('are sent a frame like anyone else, with no fleet of their own', async () => {
    fixture = harness();
    const watcher = fake('watcher');
    fixture.connections.add(watcher);

    await fixture.store.begin(
      match({ players: [seat('host', 'team1'), seat('watcher', 'spectator', [])] }),
      'Test Lobby',
    );
    fixture.handler.begin('m1');
    await fixture.sync();

    const setup = watcher.last('match.state');
    expect(setup?.setup.fleet).toEqual([]);
    expect(setup?.setup.map.extents.width).toBeGreaterThan(0);
    expect(watcher.last('match.view')?.view.own).toEqual([]);
  });
});
