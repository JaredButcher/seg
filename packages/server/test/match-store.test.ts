/**
 * `MatchStore`: what the main thread remembers about a match it is not running.
 *
 * The store used to hold the `MatchState` and the runtime advancing it, and half this file used to
 * be about projections — `setupFor`, `viewFor`, the per-recipient sequence. Those are on the match's
 * own thread now (`match/worker/entry.ts`) and are covered by `match-worker.test.ts`, which can see
 * them arrive as bytes. What is left here is the bookkeeping this thread genuinely still owns: the
 * digest, the account index, the lobby name, the results, and the chat log.
 *
 * The negative assertions matter as much as the positive ones. A store that could still hand out a
 * fleet would mean the boundary had leaked.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { harness, match, seat, type MatchFixture } from './match-harness.js';

let fixture: MatchFixture | null = null;

afterEach(async () => {
  await fixture?.close();
  fixture = null;
});

/** The three-seat fixture this file's assertions are written against. */
function players() {
  return [seat('host', 'team1'), seat('guest', 'team2'), seat('watcher', 'spectator', [])];
}

async function started(matchId = 'm1', lobbyName = 'Wolfpack'): Promise<MatchFixture> {
  fixture ??= harness();
  await fixture.store.begin(match({ matchId, players: players() }), lobbyName);
  return fixture;
}

describe('MatchStore', () => {
  it('remembers a match by its id and forgets it when it ends', async () => {
    const { store } = await started();

    expect(store.digest('m1')?.matchId).toBe('m1');
    expect(store.digest('nope')).toBeUndefined();

    await store.remove('m1');
    expect(store.digest('m1')).toBeUndefined();
  });

  it('finds the match an account is in, whichever side they are on', async () => {
    const { store } = await started();

    expect(store.digestByAccount('host')?.matchId).toBe('m1');
    expect(store.digestByAccount('watcher')?.matchId).toBe('m1');
    expect(store.digestByAccount('stranger')).toBeUndefined();
  });

  it('remembers the lobby a match began from, for a rejoin button', async () => {
    const { store } = await started();

    expect(store.lobbyNameFor('m1')).toBe('Wolfpack');
    expect(store.lobbyNameFor('nope')).toBeUndefined();
  });

  it('knows who is seated where, and nothing about what they are commanding', async () => {
    const { store } = await started();
    const digest = store.digest('m1');

    expect(digest?.players.map((player) => [player.accountId, player.team])).toEqual([
      ['host', 'team1'],
      ['guest', 'team2'],
      // A spectator has no side. That is how `teamOf` tells them apart — there is no separate
      // position field on a seated player (`worker/protocol.ts#DigestPlayer`).
      ['watcher', null],
    ]);

    // The whole point of the digest: it carries what routing needs and no ground truth at all.
    // A fleet on this thread would be a fleet the other side could be shown (planning/01 §5).
    expect(digest).not.toHaveProperty('boats');
    expect(digest).not.toHaveProperty('torpedoes');
    expect(digest).not.toHaveProperty('map');
    // The map *bounds* do cross, because an aim point has to be checked against something.
    expect(digest?.extents.width).toBeGreaterThan(0);
  });

  it('reports how much of the concurrency cap is in use', async () => {
    fixture = harness({ limit: 2 });
    await started('m1');

    expect(fixture.store.capacity).toEqual({ running: 1, limit: 2 });
  });

  // ── the account index ──────────────────────────────────────────────────────

  it('stops routing an account to a match once it is released', async () => {
    const { store } = await started();

    store.release('host');

    expect(store.digestByAccount('host')).toBeUndefined();
    // And a command for that account now reaches nothing at all, silently — which is the same
    // answer it always gave, arrived at one step earlier.
    store.command('host', { t: 'sonar', boat: 1, active: true });
    // A teammate who never left is untouched — release is per account, not per match.
    expect(store.digestByAccount('guest')?.matchId).toBe('m1');
  });

  it('never lets a stale match shadow the one an account actually joined next', async () => {
    fixture = harness();
    await started('m1', 'Wolfpack');
    fixture.store.release('host');
    // A second match, seeded with the same account id — the shape of "left match m1, then
    // started match m2 from a different lobby" that motivated the account index.
    await started('m2', 'Second Watch');

    expect(fixture.store.digestByAccount('host')?.matchId).toBe('m2');
  });

  // ── chat ────────────────────────────────────────────────────────────────────

  it('stamps chat ids in order and hands back only what a listener can hear', async () => {
    const { store } = await started();

    const line = (from: string, scope: 'team' | 'all' | 'spectator', text: string) =>
      store.addChat('m1', {
        from,
        username: from,
        team: from === 'host' ? 'team1' : from === 'guest' ? 'team2' : null,
        scope,
        text,
        at: 2_000,
      });

    expect(line('host', 'team', 'contact west')?.id).toBe(1);
    expect(line('guest', 'all', 'good luck')?.id).toBe(2);
    expect(line('watcher', 'spectator', 'nice shot')?.id).toBe(3);

    expect(store.chatFor('m1', 'host').map((e) => e.text)).toEqual(['contact west', 'good luck']);
    expect(store.chatFor('m1', 'guest').map((e) => e.text)).toEqual(['good luck']);
    // Spectators read both teams and their own channel (planning/08 §11).
    expect(store.chatFor('m1', 'watcher')).toHaveLength(3);
  });

  it('reads the audience off the digest, so chat needs no round trip', async () => {
    // Chat is the one part of a match that stayed on this thread, and this is why it could: who
    // may hear a line is answered from the digest, with nothing to ask the simulation.
    const { store } = await started();

    store.addChat('m1', {
      from: 'host',
      username: 'host',
      team: 'team1',
      scope: 'team',
      text: 'contact west',
      at: 2_000,
    });

    expect(store.chatFor('m1', 'host')).toHaveLength(1);
    expect(store.chatFor('m1', 'guest')).toHaveLength(0);
  });

  it('refuses to record chat for a match it does not have', async () => {
    fixture = harness();
    const entry = fixture.store.addChat('nope', {
      from: 'host',
      username: 'host',
      team: 'team1',
      scope: 'all',
      text: 'anyone there',
      at: 1,
    });

    expect(entry).toBeUndefined();
    expect(fixture.store.chatFor('nope', 'host')).toEqual([]);
  });
});
