/**
 * The live half of a `Modifier`'s `condition`: whether it holds right now, and what a boat's
 * stats look like once only the modifiers whose conditions hold are folded in.
 */
import { describe, expect, it } from 'vitest';

import {
  conditionMet,
  deployMatch,
  generateMap,
  getHull,
  liveStatsOf,
  refreshStats,
  type BoatState,
  type BoatTemplate,
  type Modifier,
} from '../src/index.js';

const HULL = getHull('medium');

const TOWED_ARRAY: Modifier = {
  stat: 'arrayGain',
  op: 'add',
  value: 5,
  condition: { kind: 'throttle', notch: 'slow' },
};

describe('conditionMet', () => {
  it('holds for a throttle condition exactly at its own notch', () => {
    expect(conditionMet({ kind: 'throttle', notch: 'slow' }, { throttle: 'slow' })).toBe(true);
    expect(conditionMet({ kind: 'throttle', notch: 'slow' }, { throttle: 'full' })).toBe(false);
    expect(conditionMet({ kind: 'throttle', notch: 'slow' }, { throttle: 'flank' })).toBe(false);
  });
});

describe('liveStatsOf', () => {
  it('folds in a conditional modifier while its condition holds', () => {
    const stats = liveStatsOf(HULL.stats, [TOWED_ARRAY], { throttle: 'slow' });
    expect(stats.arrayGain).toBe(HULL.stats.arrayGain + 5);
  });

  it('leaves a conditional modifier out once its condition does not hold', () => {
    const stats = liveStatsOf(HULL.stats, [TOWED_ARRAY], { throttle: 'flank' });
    expect(stats.arrayGain).toBe(HULL.stats.arrayGain);
  });

  it('never touches a modifier with no condition, whatever the context', () => {
    const unconditional: Modifier = { stat: 'sourceLevel', op: 'add', value: -6 };
    const stopped = liveStatsOf(HULL.stats, [unconditional], { throttle: 'slow' });
    const flank = liveStatsOf(HULL.stats, [unconditional], { throttle: 'flank' });
    expect(stopped.sourceLevel).toBe(HULL.stats.sourceLevel - 6);
    expect(flank.sourceLevel).toBe(HULL.stats.sourceLevel - 6);
  });
});

describe('refreshStats', () => {
  const MEDIUM: BoatTemplate = {
    name: 'S-01',
    hull: 'medium',
    modules: [{ slot: 'equipment', index: 0, module: 'towed-array' }],
  };

  function deployed(): BoatState {
    const state = deployMatch({
      matchId: 'm1',
      mode: 'deathmatch',
      map: generateMap('empty', { seed: 5, mapSize: 'small' }),
      startedAt: 0,
      players: [{ accountId: 'a', username: 'a', position: 'team1', boats: [MEDIUM] }],
    });
    const first = state.boats[0];
    if (first === undefined) throw new Error('deployment produced no boats');
    return first;
  }

  it('starts a match with the array already streamed — boats deploy at the slow notch', () => {
    const boat = deployed();
    expect(boat.throttle).toBe('slow');
    expect(boat.stats.arrayGain).toBe(HULL.stats.arrayGain + 5);
    expect(boat.stats.baffleArc).toBe(10);
  });

  it('drops the buff the instant the throttle comes up off slow', () => {
    const boat = refreshStats({ ...deployed(), throttle: 'flank' });
    expect(boat.stats.arrayGain).toBe(HULL.stats.arrayGain);
    expect(boat.stats.baffleArc).toBe(HULL.stats.baffleArc);
  });

  it('brings the buff back the moment the throttle returns to slow', () => {
    const atFlank = refreshStats({ ...deployed(), throttle: 'flank' });
    const backToSlow = refreshStats({ ...atFlank, throttle: 'slow' });
    expect(backToSlow.stats.arrayGain).toBe(HULL.stats.arrayGain + 5);
  });

  it('leaves a boat with nothing conditional fitted alone', () => {
    const plain = deployMatch({
      matchId: 'm1',
      mode: 'deathmatch',
      map: generateMap('empty', { seed: 5, mapSize: 'small' }),
      startedAt: 0,
      players: [
        {
          accountId: 'a',
          username: 'a',
          position: 'team1',
          boats: [{ name: 'S-01', hull: 'medium', modules: [] }],
        },
      ],
    }).boats[0];
    if (plain === undefined) throw new Error('deployment produced no boats');

    expect(refreshStats({ ...plain, throttle: 'flank' }).stats).toEqual(plain.stats);
  });
});
