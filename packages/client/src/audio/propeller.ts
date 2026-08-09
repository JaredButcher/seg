/**
 * @seg/client/audio/propeller — what a boat under way sounds like.
 *
 * The first *continuous* audio in the game. A pulse and an impact are events: they are born, they
 * ring, they die, and each one is a fresh graph. A propeller is a voice that exists for as long as
 * the boat does and is steered rather than triggered — which is a different lifecycle, and the
 * reason this is a class holding nodes rather than a function that makes them.
 *
 * ## Two propellers, not one
 *
 * planning/03 §3 makes cavitation a **cliff**: below the threshold a screw turns quietly, above it
 * the blades boil the water and the boat becomes the loudest thing on the map. That is the single
 * most important number a player tracks, so the ear gets both sides of it as two distinct voices
 * layered on the same hull:
 *
 * - **The blade rate** — a filtered sawtooth, the turning of a screw that is not cavitating. Low,
 *   periodic, and *tonal*: it says "there is machinery here" and nothing more alarming than that.
 * - **The cavitation hiss** — band-passed noise, and deliberately unpleasant. planning/08 §9 asks
 *   for "a rising, unpleasant hiss that should feel like exposure", which is the right instruction:
 *   the sound is not decoration, it is the player hearing themselves being detectable.
 *
 * Both are present while a boat cavitates, because the screw is still turning. The hiss is what
 * changes, and it arrives suddenly, which is the whole point of a cliff.
 *
 * ## What scales them
 *
 * **Size** sets the pitch and the weight: a bigger hull turns a bigger screw more slowly, so a
 * Heavy is lower and heavier than a Light, and the ear can tell a class apart from its note.
 * **Throttle** sets the loudness, through the speed the notch produces — quadratically, mirroring
 * `sourceLevelOf`'s `flowNoiseSpan · f²` rather than inventing a second curve. A boat at the slow
 * notch is barely there; the same boat at flank is unmistakable.
 *
 * It is worth being plain about the licence taken: what a player hears is **their own fleet**, and
 * a view frame carries no enemy boats to hear (`match/view.ts`). This is a readout of your own
 * noise, not a hydrophone. The enemy's propellers reach you the way everything hostile does, as
 * returns in the sonar picture.
 */

import { getHull, HULL_IDS, type EntityId, type HullId, type Vec2 } from '@seg/shared';

import { audioContext, isMuted, type SoundPlacement } from './context.js';

/** Peak gain of one boat's blade rate, at flank, at the largest hull, dead centre. */
const HUM_GAIN = 0.07;

/** And of its cavitation hiss. Comparable to the hum on purpose: the cliff has to be audible. */
const HISS_GAIN = 0.075;

/**
 * What a stopped boat is still worth, as a fraction of its flank-speed hum.
 *
 * Not zero. A boat at all stop is running machinery — that is what `selfNoiseAtRest` is — and a
 * fleet that fell completely silent when it stopped would read as the audio having failed rather
 * than as the boats having slowed. Small enough that stopping is still obviously quieter.
 */
const IDLE_FRACTION = 0.12;

/** The blade note of the smallest and largest hulls, Hz, at rest. Bigger screw, slower turn. */
const BLADE_HZ_SMALL = 165;
const BLADE_HZ_LARGE = 78;

/** How much the blade note rises between a standstill and flank. */
const BLADE_SPEED_RISE = 0.35;

/** Where the cavitation noise sits, Hz, and how tightly. Broad — it is a hiss, not a whistle. */
const HISS_CENTRE_HZ = 2_600;
const HISS_Q = 0.6;

/** The lowpass above the blade note, as a multiple of it. Keeps the sawtooth a chuff, not a buzz. */
const BLADE_LOWPASS_RATIO = 5;

/**
 * How fast a voice follows a change, seconds (a `setTargetAtTime` time constant).
 *
 * Long enough that a throttle change glides rather than clicks, short enough that crossing the
 * cavitation line still reads as an event. Every parameter uses the same one so that a boat winding
 * up does not have its pitch arrive before its volume.
 */
const GLIDE_S = 0.12;

/** Seconds of white noise in the shared loop buffer. Long enough not to hear the seam. */
const NOISE_SECONDS = 2;

/** One boat, as the propellers need to read it. */
export interface PropellerSource {
  readonly id: EntityId;
  readonly pos: Vec2;
  readonly hull: HullId;
  /** m/s. The speed the throttle notch actually produced, not the notch. */
  readonly speed: number;
  /** Whether it is past its cavitation threshold — the server's answer, not a recomputed one. */
  readonly cavitating: boolean;
  readonly destroyed: boolean;
}

/** How one boat's two voices should be set. Pure, and the whole of the audible model. */
export interface PropellerVoicing {
  /** The blade note, Hz. */
  readonly bladeHz: number;
  /** Gain of the blade rate, 0..1 before placement. */
  readonly humGain: number;
  /** Gain of the cavitation hiss, 0..1 before placement. Zero when not cavitating. */
  readonly hissGain: number;
}

/**
 * Where a hull sits between the smallest and the largest in the table, 0..1.
 *
 * Read off `length` rather than written down per class, so a fourth hull — or a rebalance that
 * changes one's length — is heard correctly without anybody remembering this file exists.
 */
export function hullSizeFraction(hull: HullId): number {
  const lengths = HULL_IDS.map((id) => getHull(id).length);
  const shortest = Math.min(...lengths);
  const longest = Math.max(...lengths);
  const span = Math.max(1e-6, longest - shortest);
  return Math.min(1, Math.max(0, (getHull(hull).length - shortest) / span));
}

/**
 * How loud a hull of this size is, 0..1 — the weight every voice on the boat is scaled by,
 * transients included.
 *
 * Bottoming out at 0.55 rather than at zero: a Light hitting a wall is quieter than a Heavy hitting
 * one, and it is not *silent*.
 */
export function hullWeight(hull: HullId): number {
  return 0.55 + 0.45 * hullSizeFraction(hull);
}

/** The two voices for one boat, from its size and what it is doing. */
export function voicingFor(hull: HullId, speed: number, cavitating: boolean): PropellerVoicing {
  const { stats, id } = getHull(hull);
  const fraction = stats.maxSpeed > 0 ? Math.min(1, Math.max(0, speed / stats.maxSpeed)) : 0;
  const size = hullSizeFraction(id);
  const weight = hullWeight(id);

  const restHz = BLADE_HZ_SMALL + (BLADE_HZ_LARGE - BLADE_HZ_SMALL) * size;

  return {
    bladeHz: restHz * (1 + BLADE_SPEED_RISE * fraction),
    // Quadratic in the speed fraction, like `flowNoiseSpan · f²` — one curve, two consumers.
    humGain: HUM_GAIN * weight * (IDLE_FRACTION + (1 - IDLE_FRACTION) * fraction * fraction),
    // Linear, and starting well up: crossing the line is a cliff and must not fade in.
    hissGain: cavitating ? HISS_GAIN * weight * (0.45 + 0.55 * fraction) : 0,
  };
}

/** The nodes for one boat. Created on first sight, steered thereafter, stopped when it goes. */
interface Voice {
  readonly blade: OscillatorNode;
  readonly bladeFilter: BiquadFilterNode;
  readonly hum: GainNode;
  readonly hiss: AudioBufferSourceNode;
  readonly hissFilter: BiquadFilterNode;
  readonly hissGain: GainNode;
  readonly panner: StereoPannerNode;
}

/**
 * The fleet's propellers, one voice per boat.
 *
 * Owned by the render loop (`ScopeHost`) and updated from it, because the placement of a sound
 * depends on where the camera is and the camera moves every frame rather than every view frame.
 * `update` is idempotent and cheap — it writes parameter targets, it does not rebuild anything —
 * so calling it at the display rate is the intended use.
 */
export class PropellerVoices {
  private readonly voices = new Map<EntityId, Voice>();
  private noise: AudioBuffer | null = null;

  /**
   * Bring every voice into line with this frame's fleet.
   *
   * `place` is the caller's geometry — where a world point sits in the picture — and it is a
   * callback rather than pre-computed placements so that this file needs to know nothing about
   * cameras, viewports, or zoom.
   *
   * Muting stops the voices outright rather than turning them down. A propeller is a *continuous*
   * voice: an oscillator left running at zero gain is a scheduler cost and a hardware claim paid
   * for silence, which is the one thing a mute should not do.
   */
  update(sources: readonly PropellerSource[], place: (at: Vec2) => SoundPlacement): void {
    if (isMuted()) {
      this.release();
      return;
    }

    const ctx = audioContext();
    if (ctx === null) return;

    const at = ctx.currentTime;
    const present = new Set<EntityId>();

    for (const source of sources) {
      // A wreck has no screw. Its voice is dropped rather than silenced, because a destroyed boat
      // is destroyed for the rest of the match and will never need it again.
      if (source.destroyed) continue;
      present.add(source.id);

      const voice = this.voiceFor(ctx, source.id);
      if (voice === null) continue;

      const { pan, level } = place(source.pos);
      const voicing = voicingFor(source.hull, source.speed, source.cavitating);
      const reach = Math.min(1, Math.max(0, level));

      voice.blade.frequency.setTargetAtTime(voicing.bladeHz, at, GLIDE_S);
      voice.bladeFilter.frequency.setTargetAtTime(
        voicing.bladeHz * BLADE_LOWPASS_RATIO,
        at,
        GLIDE_S,
      );
      voice.hum.gain.setTargetAtTime(voicing.humGain * reach, at, GLIDE_S);
      voice.hissGain.gain.setTargetAtTime(voicing.hissGain * reach, at, GLIDE_S);
      voice.panner.pan.setTargetAtTime(Math.min(1, Math.max(-1, pan)), at, GLIDE_S);
    }

    for (const [id, voice] of this.voices) {
      if (present.has(id)) continue;
      stop(voice);
      this.voices.delete(id);
    }
  }

  /** Silence and drop every voice. Called on mute, and before the context is closed. */
  release(): void {
    for (const voice of this.voices.values()) stop(voice);
    this.voices.clear();
    this.noise = null;
  }

  /** Whether anything is currently turning. Exposed for tests and the dev overlay. */
  get count(): number {
    return this.voices.size;
  }

  // ── internals ───────────────────────────────────────────────────────────────────

  private voiceFor(ctx: AudioContext, id: EntityId): Voice | null {
    const existing = this.voices.get(id);
    if (existing !== undefined) return existing;

    const buffer = this.noiseBuffer(ctx);
    if (buffer === null) return null;

    const at = ctx.currentTime;
    const blade = ctx.createOscillator();
    const bladeFilter = ctx.createBiquadFilter();
    const hum = ctx.createGain();
    const hiss = ctx.createBufferSource();
    const hissGain = ctx.createGain();
    const panner = ctx.createStereoPanner();

    blade.type = 'sawtooth';
    blade.frequency.setValueAtTime(BLADE_HZ_LARGE, at);
    bladeFilter.type = 'lowpass';
    bladeFilter.frequency.setValueAtTime(BLADE_HZ_LARGE * BLADE_LOWPASS_RATIO, at);
    bladeFilter.Q.setValueAtTime(0.7, at);

    hiss.buffer = buffer;
    hiss.loop = true;
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'bandpass';
    hissFilter.frequency.setValueAtTime(HISS_CENTRE_HZ, at);
    hissFilter.Q.setValueAtTime(HISS_Q, at);

    // Both voices start silent and are brought up by the first `update` — which happens on this
    // same frame. Starting at their computed gain instead would make every boat that came into
    // existence do so with a click.
    hum.gain.setValueAtTime(0, at);
    hissGain.gain.setValueAtTime(0, at);

    blade.connect(bladeFilter).connect(hum).connect(panner);
    hiss.connect(hissFilter).connect(hissGain).connect(panner);
    panner.connect(ctx.destination);

    blade.start(at);
    hiss.start(at);

    const voice: Voice = { blade, bladeFilter, hum, hiss, hissFilter, hissGain, panner };
    this.voices.set(id, voice);
    return voice;
  }

  /**
   * The white noise every cavitation hiss is filtered out of, made once and shared.
   *
   * One buffer for the whole fleet: it is a couple of seconds of samples, every voice reads it at
   * its own offset, and generating one per boat would be ten copies of the same megabyte.
   */
  private noiseBuffer(ctx: AudioContext): AudioBuffer | null {
    if (this.noise !== null) return this.noise;

    try {
      const buffer = ctx.createBuffer(
        1,
        Math.floor(ctx.sampleRate * NOISE_SECONDS),
        ctx.sampleRate,
      );
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1;
      this.noise = buffer;
      return buffer;
    } catch {
      return null;
    }
  }
}

function stop(voice: Voice): void {
  try {
    voice.blade.stop();
    voice.hiss.stop();
  } catch {
    // Already stopped, or a context that has gone away underneath us. Either way there is
    // nothing to do but drop the edges.
  }
  voice.blade.disconnect();
  voice.bladeFilter.disconnect();
  voice.hum.disconnect();
  voice.hiss.disconnect();
  voice.hissFilter.disconnect();
  voice.hissGain.disconnect();
  voice.panner.disconnect();
}
