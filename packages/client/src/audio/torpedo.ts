/**
 * @seg/client/audio/torpedo — what a weapon in the water sounds like.
 *
 * The second continuous voice in the game, and it is built on the same bargain `propeller.ts`
 * makes: a torpedo exists for as long as it is running, so it is a voice that is *steered* rather
 * than triggered, held in a class rather than made by a function. Its launch and its detonation
 * are events and go through the transient table like every other bang (`audio/transients.ts`).
 *
 * ## It is deliberately the most alarming sound in the mix
 *
 * A propeller says "there is machinery here". This says "there is a weapon in the water", and it
 * is one of the very few sounds in the game that a player has to react to *now*. So it is a high,
 * tight whine with a slow beat in it rather than a rumble — nothing else in the mix lives up
 * there, which is what makes it audible under a fleet at flank and a cave full of returns.
 *
 * The beat is a second oscillator a few hertz off the first. Two close tones interfere, and the
 * result is a pulsing that the ear reads as urgency without any of it being louder. It costs one
 * node per weapon.
 *
 * ## Fast is higher, and that is the readout
 *
 * A super-cavitating weapon runs at 55 m/s against a homing torpedo's 22, and the pitch is
 * taken straight off that ratio. So the two are immediately distinguishable by ear, and what the
 * player learns from the difference is exactly what matters: how long they have. The same number
 * makes the sound rise as a weapon accelerates out of the tube, which is the audible half of a
 * launch.
 *
 * **Your own team's weapons, like everything else the client can hear.** A hostile torpedo
 * reaches the player the way every hostile thing does — as returns in the sonar picture, and as
 * the launch alarm when its tube was heard firing.
 */

import { getWeapon, type EntityId, type TorpedoPhase, type Vec2, type WeaponId } from '@seg/shared';

import { audioContext, isMuted, type SoundPlacement } from './context.js';

/** Peak gain of one weapon's whine, at cruise, dead centre. */
const WHINE_GAIN = 0.055;

/** Where the whine sits, Hz, at the slowest and fastest speed in the weapon table. */
const WHINE_HZ_SLOW = 420;
const WHINE_HZ_FAST = 880;

/**
 * The speeds those two are pinned to, m/s — the homing and super-cavitating cruise speeds.
 *
 * Both homing loads run at 22, so the two of them sound identical here, and that is correct rather
 * than a gap: they are the same motor at the same speed, and the *only* thing that separates them
 * to a listener is that one of them pings (`content/weapons.ts`). A whine that told them apart
 * would be handing the player a reading the acoustic model does not have.
 */
const SLOWEST = 22;
const FASTEST = 55;

/** How far off the fundamental the beating oscillator sits, as a fraction of it. */
const BEAT_DETUNE = 0.012;

/** The bandpass around the pair, as a multiple of the fundamental. Keeps it a whine, not a buzz. */
const WHINE_BANDWIDTH = 1.6;

/** Seconds a parameter takes to follow a change. Short — a weapon accelerating should be heard. */
const GLIDE_S = 0.08;

/** One weapon, as the voices need to read it. */
export interface TorpedoSource {
  readonly id: EntityId;
  readonly weapon: WeaponId;
  readonly pos: Vec2;
  /** m/s. What the whine is pitched from, so a weapon winding up is heard doing it. */
  readonly speed: number;
  readonly phase: TorpedoPhase;
}

/** How one weapon's whine should be set. Pure, and the whole of the audible model. */
export interface TorpedoVoicing {
  readonly whineHz: number;
  /** 0..1 before placement. Zero for a spent weapon, which has no motor left. */
  readonly gain: number;
}

/**
 * The note and level for one weapon.
 *
 * Pinned to the two speeds in the content table rather than to each weapon's own maximum, so the
 * pitch means *how fast this thing is going* rather than *how close to its own limit* — a
 * homing torpedo at full speed must not sound like a super-cavitating one at full speed, since
 * the whole point of the difference is that one of them is coming much sooner.
 */
export function torpedoVoicing(
  weapon: WeaponId,
  speed: number,
  phase: TorpedoPhase,
): TorpedoVoicing {
  const span = Math.max(1e-6, FASTEST - SLOWEST);
  const fraction = Math.min(1, Math.max(0, (speed - SLOWEST) / span));
  const cruise = Math.max(1e-6, getWeapon(weapon).speed);

  return {
    whineHz: WHINE_HZ_SLOW + (WHINE_HZ_FAST - WHINE_HZ_SLOW) * fraction,
    // Against its own cruise speed, so a weapon still winding out of the tube fades in rather
    // than arriving at full level — which is what makes the launch read as a launch.
    gain: phase === 'spent' ? 0 : WHINE_GAIN * Math.min(1, speed / cruise),
  };
}

/** The nodes for one weapon. Created on first sight, steered, stopped when it leaves the frames. */
interface Voice {
  readonly tone: OscillatorNode;
  readonly beat: OscillatorNode;
  readonly filter: BiquadFilterNode;
  readonly gain: GainNode;
  readonly panner: StereoPannerNode;
}

/**
 * The team's torpedoes, one voice each.
 *
 * Owned and updated by the render loop for the reason `PropellerVoices` is: where a sound sits
 * depends on where the camera is, and the camera moves every display frame rather than every
 * view frame. `update` writes parameter targets and builds nothing, so calling it at the display
 * rate is the intended use.
 */
export class TorpedoVoices {
  private readonly voices = new Map<EntityId, Voice>();

  update(sources: readonly TorpedoSource[], place: (at: Vec2) => SoundPlacement): void {
    if (isMuted()) {
      this.release();
      return;
    }

    const ctx = audioContext();
    if (ctx === null) return;

    const at = ctx.currentTime;
    const present = new Set<EntityId>();

    for (const source of sources) {
      // A spent weapon is still in the frames for the few seconds its detonation rings, and it
      // must not still be whining while it does. Dropped rather than silenced: it will never
      // need the voice again.
      if (source.phase === 'spent') continue;
      present.add(source.id);

      const voice = this.voiceFor(ctx, source.id);
      if (voice === null) continue;

      const { pan, level } = place(source.pos);
      const voicing = torpedoVoicing(source.weapon, source.speed, source.phase);
      const reach = Math.min(1, Math.max(0, level));

      voice.tone.frequency.setTargetAtTime(voicing.whineHz, at, GLIDE_S);
      voice.beat.frequency.setTargetAtTime(voicing.whineHz * (1 + BEAT_DETUNE), at, GLIDE_S);
      voice.filter.frequency.setTargetAtTime(voicing.whineHz * WHINE_BANDWIDTH, at, GLIDE_S);
      voice.gain.gain.setTargetAtTime(voicing.gain * reach, at, GLIDE_S);
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
  }

  /** Whether anything is running. Exposed for tests and the dev overlay. */
  get count(): number {
    return this.voices.size;
  }

  private voiceFor(ctx: AudioContext, id: EntityId): Voice | null {
    const existing = this.voices.get(id);
    if (existing !== undefined) return existing;

    const at = ctx.currentTime;
    const tone = ctx.createOscillator();
    const beat = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();

    tone.type = 'sawtooth';
    beat.type = 'sawtooth';
    tone.frequency.setValueAtTime(WHINE_HZ_SLOW, at);
    beat.frequency.setValueAtTime(WHINE_HZ_SLOW * (1 + BEAT_DETUNE), at);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(WHINE_HZ_SLOW * WHINE_BANDWIDTH, at);
    filter.Q.setValueAtTime(2.4, at);

    // Silent until the first `update`, which happens on this same frame. Starting at the
    // computed gain would make every weapon enter with a click.
    gain.gain.setValueAtTime(0, at);

    tone.connect(filter);
    beat.connect(filter);
    filter.connect(gain).connect(panner);
    panner.connect(ctx.destination);

    tone.start(at);
    beat.start(at);

    const voice: Voice = { tone, beat, filter, gain, panner };
    this.voices.set(id, voice);
    return voice;
  }
}

function stop(voice: Voice): void {
  try {
    voice.tone.stop();
    voice.beat.stop();
  } catch {
    // Already stopped, or a context that has gone away underneath us. Either way there is
    // nothing to do but drop the edges.
  }
  voice.tone.disconnect();
  voice.beat.disconnect();
  voice.filter.disconnect();
  voice.gain.disconnect();
  voice.panner.disconnect();
}
