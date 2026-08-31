/**
 * What a weapon sounds like — and, since the whine became the main warning a player gets, what it
 * is allowed to claim.
 *
 * `torpedoVoicing` is the whole audible model for a torpedo and it is pure, so the interesting
 * half can be tested without an `AudioContext`. Two things are being pinned:
 *
 * 1. **The pitch is a readout.** It says how fast the thing is going, which is to say how long the
 *    player has, and it has to say the same thing for a weapon of yours and a weapon of his at the
 *    same speed.
 * 2. **It refuses to guess.** A hostile contact the team has not identified carries no speed, and
 *    the one thing the voice must not do is invent one — `audio/torpedo.ts#WHINE_HZ_UNKNOWN` is
 *    the sound of not knowing, and it is a distinct pitch rather than a plausible one.
 */

import { getWeapon, type TorpedoPhase, type WeaponId } from '@seg/shared';
import { describe, expect, it } from 'vitest';

import { torpedoVoicing, type TorpedoSource } from '../src/audio/torpedo.js';

function own(weapon: WeaponId, speed: number, phase: TorpedoPhase = 'running'): TorpedoSource {
  return { id: 1, weapon, pos: { x: 0, y: 0 }, speed, phase, hostile: false };
}

function foe(weapon: WeaponId | null): TorpedoSource {
  return { id: 1, weapon, pos: { x: 0, y: 0 }, speed: null, phase: null, hostile: true };
}

const ACTIVE = getWeapon('active-torpedo');
const SCV = getWeapon('super-cavitating');

describe('one of your own weapons', () => {
  it('fades in as it winds out of the tube, which is the audible half of a launch', () => {
    const creeping = torpedoVoicing(own('active-torpedo', 7, 'launch'));
    const cruising = torpedoVoicing(own('active-torpedo', ACTIVE.speed));

    expect(creeping.gain).toBeLessThan(cruising.gain);
  });

  it('holds the floor pitch below the slowest cruise in the table, rather than going lower', () => {
    // The pitch scale runs from the homing cruise speed to the super-cavitating one, so a weapon
    // creeping through its launch phase at 7 m/s is *below* the bottom of it and clamps there. A
    // homing weapon therefore leaves the tube at its cruise pitch and only gets louder; the rise
    // in pitch belongs to the load that is actually going to speed up past 22.
    expect(torpedoVoicing(own('active-torpedo', 7, 'launch')).whineHz).toBe(
      torpedoVoicing(own('active-torpedo', ACTIVE.speed)).whineHz,
    );
    expect(torpedoVoicing(own('super-cavitating', 7, 'launch')).whineHz).toBeLessThan(
      torpedoVoicing(own('super-cavitating', SCV.speed)).whineHz,
    );
  });

  it('pitches a super-cavitating weapon far above a homing one', () => {
    // The readout that matters: one of them arrives in a third of the time.
    const homing = torpedoVoicing(own('active-torpedo', ACTIVE.speed));
    const sprint = torpedoVoicing(own('super-cavitating', SCV.speed));

    expect(sprint.whineHz).toBeGreaterThan(homing.whineHz * 1.5);
  });

  it('sounds the two homing loads identically, because they are the same motor', () => {
    // A passive torpedo differs from an active one by a transducer, not by a propeller
    // (`content/weapons.ts`). Telling them apart by ear would be a reading the model does not have.
    expect(torpedoVoicing(own('active-torpedo', 22))).toEqual(
      torpedoVoicing(own('passive-torpedo', 22)),
    );
  });

  it('goes silent once it is spent — a warhead that has gone off has no motor', () => {
    expect(torpedoVoicing(own('active-torpedo', 0, 'spent')).gain).toBe(0);
  });
});

describe('one of his', () => {
  it('is louder than one of yours at the same speed', () => {
    // Yours is a receipt for a decision you made and it is running away from you. His is the one
    // continuous sound in the game that means something is about to happen to you.
    const mine = torpedoVoicing(own('active-torpedo', ACTIVE.speed));
    const his = torpedoVoicing(foe('active-torpedo'));

    expect(his.gain).toBeGreaterThan(mine.gain);
  });

  it('takes its pitch from the identified load, since a contact carries no speed', () => {
    // The picture measures a pose and never a rate, so once the team has cleared
    // `identificationThreshold` and knows *which* load it is, the table supplies the reading.
    expect(torpedoVoicing(foe('active-torpedo')).whineHz).toBeCloseTo(
      torpedoVoicing(own('active-torpedo', ACTIVE.speed)).whineHz,
      6,
    );
    expect(torpedoVoicing(foe('super-cavitating')).whineHz).toBeCloseTo(
      torpedoVoicing(own('super-cavitating', SCV.speed)).whineHz,
      6,
    );
  });

  it('refuses to claim a speed for a weapon it has not identified', () => {
    // The audible half of the generic dart. Below `identificationThreshold` a team knows a weapon
    // is in the water and no more, and the pitch has to carry exactly that much — being wrong
    // about "how long have I got" is worse in either direction than saying nothing.
    const unknown = torpedoVoicing(foe(null));

    expect(unknown.whineHz).toBeGreaterThan(torpedoVoicing(foe('active-torpedo')).whineHz);
    expect(unknown.whineHz).toBeLessThan(torpedoVoicing(foe('super-cavitating')).whineHz);
    // And it is still audible — not knowing which load is coming is not a reason to be quiet
    // about the fact that one is.
    expect(unknown.gain).toBeGreaterThan(0);
  });

  it('is at full level whatever it is doing, because there is no wind-up to hear', () => {
    // By the time a weapon is a confirmed contact it left its launch phase long ago, and fading it
    // by a speed the picture never measured would be inventing the number this path lacks.
    expect(torpedoVoicing(foe('active-torpedo')).gain).toBe(torpedoVoicing(foe(null)).gain);
  });
});
