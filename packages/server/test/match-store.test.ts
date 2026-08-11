import {
  deployMatch,
  generateMap,
  type BoatTemplate,
  type DeployingPlayer,
  type MatchState,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

import { MatchStore } from '../src/match/store.js';

const BOAT: BoatTemplate = { name: 'S-01', hull: 'light', modules: [] };

function player(
  accountId: string,
  position: DeployingPlayer['position'],
  boats: readonly BoatTemplate[] = [BOAT],
): DeployingPlayer {
  return { accountId, username: accountId, position, boats };
}

function match(matchId = 'm1'): MatchState {
  return deployMatch({
    matchId,
    mode: 'objective-capture',
    map: generateMap('empty', { seed: 1, mapSize: 'small' }),
    startedAt: 1_000,
    players: [
      player('host', 'team1'),
      player('guest', 'team2'),
      player('watcher', 'spectator', []),
    ],
  });
}

describe('MatchStore', () => {
  it('remembers a match by its id and forgets it when it ends', () => {
    const store = new MatchStore();
    const state = match();

    store.store(state, 'Wolfpack');
    expect(store.find('m1')?.matchId).toBe('m1');
    expect(store.find('nope')).toBeUndefined();

    store.remove('m1');
    expect(store.find('m1')).toBeUndefined();
  });

  it('finds the match an account is in, whichever side they are on', () => {
    const store = new MatchStore();
    store.store(match(), 'Wolfpack');

    expect(store.findByAccount('host')?.matchId).toBe('m1');
    expect(store.findByAccount('watcher')?.matchId).toBe('m1');
    expect(store.findByAccount('stranger')).toBeUndefined();
  });

  it('remembers the lobby a match began from, for a rejoin button', () => {
    const store = new MatchStore();
    store.store(match(), 'Wolfpack');

    expect(store.lobbyNameFor('m1')).toBe('Wolfpack');
    expect(store.lobbyNameFor('nope')).toBeUndefined();
  });

  it('projects a setup that holds one side only, while the store holds both', () => {
    const store = new MatchStore();
    const state = match();
    store.store(state, 'Wolfpack');

    expect(state.boats).toHaveLength(2);

    const host = store.setupFor('m1', 'host');
    expect(host?.you.team).toBe('team1');
    expect(host?.fleet).toHaveLength(1);
    expect(host?.fleet.every((boat) => boat.team === 'team1')).toBe(true);

    // A spectator commands nothing and, until spectator vision is settled, is told nothing.
    expect(store.setupFor('m1', 'watcher')?.fleet).toEqual([]);
  });

  it('numbers view frames per recipient, so one connection cannot skew another', () => {
    const store = new MatchStore();
    store.store(match(), 'Wolfpack');

    expect(store.viewFor('m1', 'host')?.seq).toBe(1);
    expect(store.viewFor('m1', 'host')?.seq).toBe(2);
    expect(store.viewFor('m1', 'guest')?.seq).toBe(1);
    expect(store.viewFor('nope', 'host')).toBeUndefined();
  });

  it('marks a player disconnected without removing them or their boats', () => {
    const store = new MatchStore();
    store.store(match(), 'Wolfpack');

    store.setConnected('host', false);

    const state = store.find('m1');
    expect(state?.players.find((p) => p.accountId === 'host')?.connected).toBe(false);
    expect(state?.boats.filter((b) => b.owner === 'host')).toHaveLength(1);
  });

  // ── the account index ──────────────────────────────────────────────────────

  it('stops routing an account to a match once it is released', () => {
    const store = new MatchStore();
    store.store(match(), 'Wolfpack');

    store.release('host');

    expect(store.findByAccount('host')).toBeUndefined();
    expect(store.setActiveSonar('host', 1, true)).toBe(false);
    // A teammate who never left is untouched — release is per account, not per match.
    expect(store.findByAccount('guest')?.matchId).toBe('m1');
  });

  it('never lets a stale match shadow the one an account actually joined next', () => {
    const store = new MatchStore();
    store.store(match('m1'), 'Wolfpack');
    store.release('host');
    // A second match, seeded with the same account id — the shape of "left match m1, then
    // started match m2 from a different lobby" that motivated the account index.
    store.store(match('m2'), 'Second Watch');

    expect(store.findByAccount('host')?.matchId).toBe('m2');
  });

  // ── chat ────────────────────────────────────────────────────────────────────

  it('stamps chat ids in order and hands back only what a listener can hear', () => {
    const store = new MatchStore();
    store.store(match(), 'Wolfpack');

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

  it('refuses to record chat for a match it does not have', () => {
    const store = new MatchStore();
    const entry = store.addChat('nope', {
      from: 'host',
      username: 'host',
      team: 'team1',
      scope: 'all',
      text: 'anyone there',
      at: 1,
    });

    expect(entry).toBeUndefined();
    expect(store.chatFor('nope', 'host')).toEqual([]);
  });
});
