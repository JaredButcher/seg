import { generateMap } from '@seg/shared';
import { describe, expect, it } from 'vitest';

import { MatchStore } from '../src/match/store.js';

describe('MatchStore', () => {
  it('remembers a match by its id and returns its map', () => {
    const store = new MatchStore();
    const map = generateMap('empty', { seed: 1, mapSize: 'small' });

    store.store('m1', map);

    expect(store.mapFor('m1')).toEqual(map);
    expect(store.mapFor('nope')).toBeUndefined();
  });

  it('forgets a match that has ended', () => {
    const store = new MatchStore();
    store.store('m1', generateMap('empty', { seed: 1, mapSize: 'small' }));

    store.remove('m1');

    expect(store.mapFor('m1')).toBeUndefined();
  });
});
