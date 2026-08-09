/**
 * The loading gear, as a state machine.
 *
 * Small, pure, and worth its own file because it is the part of the weapons system a player
 * operates constantly and the part whose bugs are invisible: a tube that reloads a tenth of a
 * second fast, or that comes back holding the wrong variant, is a thing nobody notices until a
 * salvo is a weapon short.
 */

import {
  canFire,
  chooseNext,
  describeTubeProblem,
  fired,
  getHull,
  newTube,
  reloadSecondsFor,
  stepTube,
  swapTo,
  UNLOAD_SECONDS,
  type TubeState,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

const STATS = getHull('medium').stats;

/** Run a tube forward `seconds` in 20 Hz steps, the way the weapons phase does. */
function run(tube: TubeState, seconds: number): TubeState {
  let current = tube;
  for (let i = 0; i < Math.round(seconds * 20); i += 1) current = stepTube(current, STATS, 1 / 20);
  return current;
}

describe('a fresh tube', () => {
  it('is loaded, and queues the same variant behind itself', () => {
    const tube = newTube(0, 'standard');
    expect(tube).toEqual({
      index: 0,
      weapon: 'standard',
      next: 'standard',
      status: 'loaded',
      readyInSeconds: 0,
    });
    expect(canFire(tube)).toBe(true);
    expect(describeTubeProblem(tube)).toBeNull();
  });

  it('cannot fire a load the weapons phase has not been built for', () => {
    // The four loiter loads are marked undeployable in the content table rather than filtered
    // out somewhere else, so this is the same rule the picker and the server both read.
    const drone = chooseNext(newTube(0, 'passive-sonar-drone'), 'passive-sonar-drone');
    expect(canFire({ ...drone, weapon: 'passive-sonar-drone' })).toBe(false);
  });
});

describe('firing', () => {
  it('starts reloading immediately, with the queued variant already showing', () => {
    // Reloading beginning on the tick of the shot is the whole of the tempo — the player is
    // never asked a question at the worst possible moment, because `next` was the question.
    const tube = fired(chooseNext(newTube(1, 'standard'), 'super-cavitating'), STATS);

    expect(tube.status).toBe('reloading');
    expect(tube.weapon).toBe('super-cavitating');
    expect(tube.readyInSeconds).toBe(reloadSecondsFor(STATS));
    expect(canFire(tube)).toBe(false);
  });

  it('is loaded again after exactly the hull’s reload time, and not before', () => {
    const tube = fired(newTube(0, 'standard'), STATS);
    const reload = reloadSecondsFor(STATS);

    expect(run(tube, reload - 0.1).status).toBe('reloading');
    expect(run(tube, reload + 0.1).status).toBe('loaded');
    expect(run(tube, reload + 0.1).readyInSeconds).toBe(0);
  });
});

describe('choosing the next load', () => {
  it('changes nothing about the tube now', () => {
    const loaded = newTube(0, 'standard');
    const queued = chooseNext(loaded, 'super-cavitating');

    expect(queued.status).toBe('loaded');
    expect(queued.weapon).toBe('standard');
    expect(queued.next).toBe('super-cavitating');
    expect(canFire(queued)).toBe(true);
  });

  it('is legal mid-reload — it is a note about the cycle after this one', () => {
    // Refusing it would make the picker behave differently depending on a timer the player is
    // not watching, which is worse than a choice that quietly applies one cycle later.
    const reloading = fired(newTube(0, 'standard'), STATS);
    expect(chooseNext(reloading, 'super-cavitating').next).toBe('super-cavitating');
  });

  it('hands back the same tube when nothing changed', () => {
    const tube = newTube(0, 'standard');
    expect(chooseNext(tube, 'standard')).toBe(tube);
  });
});

describe('swapping a loaded tube', () => {
  it('empties it first, then reloads — and the total is both times', () => {
    const swapped = swapTo(newTube(0, 'standard'), 'super-cavitating');
    expect(swapped.status).toBe('unloading');
    expect(swapped.readyInSeconds).toBe(UNLOAD_SECONDS);

    // Bracketed either side of each boundary rather than tested on it. Summing 0.05 a hundred
    // and sixty times does not land on 8 exactly, and a test that demanded it would be asserting
    // on the float rather than on the tube.
    expect(run(swapped, UNLOAD_SECONDS - 0.1).status).toBe('unloading');
    const reloading = run(swapped, UNLOAD_SECONDS + 0.1);
    expect(reloading.status).toBe('reloading');
    expect(reloading.weapon).toBe('super-cavitating');

    const total = UNLOAD_SECONDS + reloadSecondsFor(STATS);
    expect(run(swapped, total - 0.1).status).toBe('reloading');
    expect(run(swapped, total + 0.1).status).toBe('loaded');
    expect(run(swapped, total + 0.1).weapon).toBe('super-cavitating');
  });

  it('carries the overshoot across the seam, so the total does not depend on tick alignment', () => {
    // A tick that finishes the unload with time to spare spends the remainder on the reload.
    // Without that, a swap would cost a variable extra fraction of a tick and two identical
    // matches could disagree about when a tube came back.
    const swapped = swapTo(newTube(0, 'standard'), 'super-cavitating');
    const seam = stepTube({ ...swapped, readyInSeconds: 0.02 }, STATS, 0.05);

    expect(seam.status).toBe('reloading');
    expect(seam.readyInSeconds).toBeCloseTo(reloadSecondsFor(STATS) - 0.03, 6);
  });

  it('refuses a tube that is already cycling — there is nothing in it to eject', () => {
    const reloading = fired(newTube(0, 'standard'), STATS);
    expect(swapTo(reloading, 'super-cavitating')).toBe(reloading);
  });
});

describe('describeTubeProblem', () => {
  it('names the tube and what it is doing, in the player’s numbering', () => {
    expect(describeTubeProblem(fired(newTube(2, 'standard'), STATS))).toBe('Tube 3 is reloading.');
    expect(describeTubeProblem(swapTo(newTube(0, 'standard'), 'super-cavitating'))).toBe(
      'Tube 1 is being emptied.',
    );
    expect(describeTubeProblem({ ...newTube(1, 'standard'), status: 'empty' })).toBe(
      'Tube 2 is out of action.',
    );
  });
});
