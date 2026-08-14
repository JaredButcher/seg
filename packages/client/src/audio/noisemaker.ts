/**
 * @seg/client/audio/noisemaker — what a countermeasure sounds like, which is nothing like a weapon.
 *
 * The third continuous voice, after the propellers and the torpedo whines, and it is built on the
 * same bargain both of those make: a noisemaker exists for as long as it is sinking, so it is a
 * voice that is *steered* rather than triggered, held in a class and updated at the display rate.
 * The clack of the launcher is an event and goes through the transient table like every other bang
 * (`audio/transients.ts`, `countermeasure-drop`).
 *
 * ## It is noise, and it is the only voice here that actually is
 *
 * Everything else in the mix is oscillators — a hull hum, a torpedo whine, a ping. A noisemaker is
 * a drum of broadband racket (`content/weapons.ts`: 96 dB, the loudest continuous source in the
 * game), and it has to sound like one or the mechanic is a lie: the thing that makes it work is
 * that a seeker cannot pick a signal out of it, and a listener who hears a clean tone will not
 * believe that for a second. So this is a filtered white-noise loop and nothing else.
 *
 * That also solves the problem it exists to create. A player who has dropped a countermeasure has
 * deliberately made a large part of the ocean unreadable, and they should be able to *hear* that
 * they have: hiss sits across the whole band and masks the fine detail of everything behind it,
 * which is the same thing it is doing to the seekers, done to the player's ears by the same
 * mechanism rather than by a second one that has to be kept in step.
 *
 * ## Wide, and slowly wobbling
 *
 * A bandpass with a very low Q — half an octave of nothing in particular, centred low enough to sit
 * under the torpedo whines rather than fighting them. The centre frequency is walked up and down by
 * a slow LFO, which is what stops it reading as a hiss on a tape and makes it read as a mechanical
 * thing thrashing in the water: a fixed-filter noise loop is background, and background is exactly
 * what this must not sound like.
 *
 * ## It is loud, and it does not fade
 *
 * `NOISE_GAIN` is above every other continuous voice in the game, including a hostile torpedo's
 * whine, and it stays flat for the whole of the noisemaker's life. A weapon fades in as it winds
 * out of the tube because it really is accelerating; a noisemaker is at full output the instant it
 * is dropped and stays there until it dies, which is what the simulation does with it too
 * (`sim/weapons/launch.ts#dropCountermeasure` starts it at terminal speed, so the acoustic model
 * never sees a quiet one either).
 *
 * ## His as well as yours
 *
 * The same voice for both, and no hostile variant — which is the one place this differs from
 * `audio/torpedo.ts`, where his weapon is deliberately louder than yours. There is nothing to
 * distinguish: a noisemaker is not coming for anybody, and what it means to the player is identical
 * whoever dropped it. *There is racket over there, and nothing in it can be trusted.*
 */

import type { EntityId, Vec2 } from '@seg/shared';

import { audioContext, isMuted, type SoundPlacement } from './context.js';

/**
 * Peak gain of one noisemaker, dead centre.
 *
 * Above the hostile torpedo whine's 0.085, and it earns that: this is the only sound in the game
 * that is *itself* a thing happening to the player's information rather than a report of something
 * happening somewhere. It is also noise rather than a tone, and broadband material at equal peak
 * gain reads much quieter than a saw wave — the two together put it about where a close propeller
 * sits, which is where a drum of racket a few hundred metres away belongs.
 */
const NOISE_GAIN = 0.11;

/** Where the band sits at the bottom and the top of its wobble, Hz. */
const BAND_LOW_HZ = 260;
const BAND_HIGH_HZ = 720;

/**
 * How wide the band is — a `Q` under one, which is most of two octaves.
 *
 * Deliberately barely a filter at all. What it is for is taking the very top and the very bottom
 * off so the voice sits *under* the whines and *over* the hull hums with room for both, not for
 * giving the noise a pitch. A resonant Q here would produce a tone, and a tone is the one thing
 * this may not be (see the header).
 */
const BAND_Q = 0.7;

/** How fast the band walks up and down, Hz. Slow — this is a wallow, not a siren. */
const SWEEP_HZ = 0.45;

/** How far the sweep pushes the band either way, Hz. */
const SWEEP_DEPTH_HZ = (BAND_HIGH_HZ - BAND_LOW_HZ) / 2;

/** Seconds of noise in the loop buffer. Long enough that the seam is not a rhythm. */
const LOOP_SECONDS = 3;

/** Seconds a parameter takes to follow a change. Longer than a whine's — nothing here is urgent. */
const GLIDE_S = 0.15;

/**
 * One noisemaker in the water, as the voice needs to read it — **yours or his**.
 *
 * Much less than a `TorpedoSource` wants, and that is the point: there is no speed to read a pitch
 * off, no phase that changes what it sounds like, and no side that changes how loud it is. A
 * position and an identity is the whole of it.
 */
export interface NoisemakerSource {
  /**
   * Its entity id, or the *contact* id for one of his.
   *
   * The two are separate id spaces of plain numbers and they collide, so `hostile` is part of the
   * voice map's key exactly as it is in `audio/torpedo.ts#voiceKey`.
   */
  readonly id: EntityId;
  readonly pos: Vec2;
  readonly hostile: boolean;
}

/** The nodes for one noisemaker. Created on first sight, steered, stopped when it leaves the frames. */
interface Voice {
  readonly source: AudioBufferSourceNode;
  readonly filter: BiquadFilterNode;
  readonly sweep: OscillatorNode;
  readonly sweepGain: GainNode;
  readonly gain: GainNode;
  readonly panner: StereoPannerNode;
}

/**
 * Every noisemaker in the water, one voice each.
 *
 * Owned and updated by the render loop for the reason `TorpedoVoices` is: where a sound sits depends
 * on where the camera is, and the camera moves every display frame rather than every view frame.
 * `update` writes parameter targets and builds nothing for a voice that already exists, so calling
 * it at the display rate is the intended use.
 */
export class NoisemakerVoices {
  private readonly voices = new Map<string, Voice>();
  private buffer: AudioBuffer | null = null;
  private bufferFor: AudioContext | null = null;

  update(sources: readonly NoisemakerSource[], place: (at: Vec2) => SoundPlacement): void {
    if (isMuted()) {
      this.release();
      return;
    }

    const ctx = audioContext();
    if (ctx === null) return;

    const at = ctx.currentTime;
    const present = new Set<string>();

    for (const source of sources) {
      const key = `${source.hostile ? 'foe' : 'own'}:${String(source.id)}`;
      present.add(key);

      const voice = this.voiceFor(ctx, key);
      if (voice === null) continue;

      const { pan, level } = place(source.pos);
      const reach = Math.min(1, Math.max(0, level));

      // Flat at `NOISE_GAIN` before placement — see the header on why there is no fade and no
      // hostile level. Placement is the only thing that moves.
      voice.gain.gain.setTargetAtTime(NOISE_GAIN * reach, at, GLIDE_S);
      voice.panner.pan.setTargetAtTime(Math.min(1, Math.max(-1, pan)), at, GLIDE_S);
    }

    // Anything not in this frame's list has gone: it sank into the seabed, its clock ran out, or
    // his contact slipped and the picture no longer stands behind where it was. All three go quiet,
    // for the reason `audio/torpedo.ts` gives about not holding a stale contact.
    for (const [key, voice] of this.voices) {
      if (present.has(key)) continue;
      stop(voice);
      this.voices.delete(key);
    }
  }

  /** Silence and drop every voice. Called on mute, and before the context is closed. */
  release(): void {
    for (const voice of this.voices.values()) stop(voice);
    this.voices.clear();
  }

  /** Whether anything is running. Exposed for tests and the dev overlay. */
  get count(): number {
    return this.voices.size;
  }

  private voiceFor(ctx: AudioContext, key: string): Voice | null {
    const existing = this.voices.get(key);
    if (existing !== undefined) return existing;

    const loop = this.noiseBuffer(ctx);
    if (loop === null) return null;

    const at = ctx.currentTime;
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const sweep = ctx.createOscillator();
    const sweepGain = ctx.createGain();
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();

    source.buffer = loop;
    source.loop = true;

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime((BAND_LOW_HZ + BAND_HIGH_HZ) / 2, at);
    filter.Q.setValueAtTime(BAND_Q, at);

    // The wobble: an LFO driving the filter's centre rather than anything audible in its own right.
    // Scaled through its own gain node because `frequency` is in hertz and an oscillator is ±1.
    sweep.type = 'sine';
    sweep.frequency.setValueAtTime(SWEEP_HZ, at);
    sweepGain.gain.setValueAtTime(SWEEP_DEPTH_HZ, at);
    sweep.connect(sweepGain).connect(filter.frequency);

    // Silent until the first `update`, which happens on this same frame. Starting at the computed
    // gain would make every noisemaker enter with a click — and this is the loudest voice here.
    gain.gain.setValueAtTime(0, at);

    source.connect(filter).connect(gain).connect(panner);
    panner.connect(ctx.destination);

    source.start(at);
    sweep.start(at);

    const voice: Voice = { source, filter, sweep, sweepGain, gain, panner };
    this.voices.set(key, voice);
    return voice;
  }

  /**
   * The white noise every voice loops. One buffer for the whole class, remade only if the device
   * changes — three seconds of stereo-agnostic mono hiss is a hundred and thirty thousand samples,
   * and a copy per noisemaker would be a real allocation for a sound that is identical anyway.
   *
   * Held on the instance rather than at module scope, unlike `audio/transients.ts`'s, because that
   * one is a burst buffer shared by a function and this one is owned by an object with a `release`.
   */
  private noiseBuffer(ctx: AudioContext): AudioBuffer | null {
    if (this.buffer !== null && this.bufferFor === ctx) return this.buffer;

    try {
      const made = ctx.createBuffer(1, Math.floor(ctx.sampleRate * LOOP_SECONDS), ctx.sampleRate);
      const samples = made.getChannelData(0);
      for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1;
      this.buffer = made;
      this.bufferFor = ctx;
      return made;
    } catch {
      return null;
    }
  }
}

function stop(voice: Voice): void {
  try {
    voice.source.stop();
    voice.sweep.stop();
  } catch {
    // Already stopped, or a context that has gone away underneath us. Either way there is
    // nothing to do but drop the edges.
  }
  voice.source.disconnect();
  voice.sweep.disconnect();
  voice.sweepGain.disconnect();
  voice.filter.disconnect();
  voice.gain.disconnect();
  voice.panner.disconnect();
}
