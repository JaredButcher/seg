/**
 * Deciding which appearance of a transient on the wire is the *event*.
 *
 * A view frame carries what is still ringing, so one collision appears in every frame for the five
 * or six seconds it takes to decay — a hundred frames at 10 Hz. Playing all of them would be a
 * machine-gun where the design asks for a thud. This is the tracker that turns the state back into
 * an event, and it is the exact counterpart of `ping-rings`' job on `lastPingTick`.
 */

import type { BoatTransient } from '@seg/shared';
import { describe, expect, it } from 'vitest';

import { TransientCues, type TransientSource } from '../src/audio/cues.js';

function boat(transients: readonly BoatTransient[], id = 1, mine = false): TransientSource {
  return { id, pos: { x: 100, y: 200 }, hull: 'medium', mine, transients };
}

const BANG: BoatTransient = { kind: 'bottoming', tick: 40 };

describe('TransientCues', () => {
  it('plays nothing for a boat it is seeing for the first time', () => {
    // The reconnect case. A returning client's first frame carries whatever was ringing while they
    // were away, and a barrage of bangs from events they missed is not a welcome back.
    expect(new TransientCues().observe([boat([BANG])])).toEqual([]);
  });

  it('plays a bang once, however many frames report it', () => {
    const cues = new TransientCues();
    cues.observe([boat([])]);

    const first = cues.observe([boat([BANG])]);
    expect(first).toEqual([
      { kind: 'bottoming', at: { x: 100, y: 200 }, hull: 'medium', mine: false },
    ]);

    for (let i = 0; i < 60; i += 1) expect(cues.observe([boat([BANG])])).toEqual([]);
  });

  it('plays a second bang of the same kind on a later tick', () => {
    const cues = new TransientCues();
    cues.observe([boat([])]);
    cues.observe([boat([BANG])]);

    // Two walls, a second apart. Same kind, different tick, so it is a different event.
    const again: BoatTransient = { kind: 'bottoming', tick: 60 };
    expect(cues.observe([boat([BANG, again])])).toHaveLength(1);
    expect(cues.observe([boat([BANG, again])])).toEqual([]);
  });

  it('plays two different kinds fired on the same tick', () => {
    const cues = new TransientCues();
    cues.observe([boat([])]);

    const both = cues.observe([boat([BANG, { kind: 'collision', tick: 40 }])]);
    expect(both.map((cue) => cue.kind)).toEqual(['bottoming', 'collision']);
  });

  it('keeps boats apart, so one boat’s bang is not another boat’s silence', () => {
    const cues = new TransientCues();
    cues.observe([boat([], 1), boat([], 2)]);

    const one = cues.observe([boat([BANG], 1), boat([], 2)]);
    expect(one).toHaveLength(1);

    // The second boat hits a wall on the same tick. It is a separate event and gets its own thud.
    const two = cues.observe([boat([BANG], 1), boat([BANG], 2)]);
    expect(two).toHaveLength(1);
  });

  it('forgets a boat that has left the frames, and treats it as new if it comes back', () => {
    const cues = new TransientCues();
    cues.observe([boat([])]);
    cues.observe([boat([BANG])]);

    // A different match reusing the id. Nothing carried over should make it silent, and nothing
    // carried over should make it loud either — first sight is first sight.
    cues.observe([]);
    expect(cues.observe([boat([BANG])])).toEqual([]);
  });

  it('carries the position the frame reported, so the thud is placed where the boat is', () => {
    const cues = new TransientCues();
    cues.observe([boat([])]);

    const [cue] = cues.observe([{ ...boat([BANG]), pos: { x: 900, y: 40 }, hull: 'heavy' }]);
    expect(cue?.at).toEqual({ x: 900, y: 40 });
    expect(cue?.hull).toBe('heavy');
  });

  it('carries whose boat it was, so the caller can pick which path to play it on', () => {
    // The one field that decides between a bang across the water and the hull ringing around you
    // (`audio/transients.ts#playHullShock`). It is read off the source rather than worked out
    // here, because "the boat I am driving" is a fact about the session and not about the noise.
    const cues = new TransientCues();
    cues.observe([boat([], 1, true), boat([], 2, false)]);

    const hit: BoatTransient = { kind: 'hull-damage', tick: 50 };
    const both = cues.observe([boat([hit], 1, true), boat([hit], 2, false)]);

    expect(both.map((cue) => cue.mine)).toEqual([true, false]);
  });
});
