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
 * player learns from the difference is exactly what matters: how long they have.
 *
 * The scale runs *between* those two speeds and clamps below the lower one, which means a weapon
 * creeping through its launch phase at `TORPEDO_LAUNCH_SPEED` sits at the floor pitch rather than
 * under it. A super-cavitating weapon is therefore heard climbing as it winds up; a homing one
 * leaves the tube already at its cruise pitch and only *fades in*, which is what its `gain` term
 * is for. Both read as a launch — one of them just does it with the volume knob.
 *
 * ## His weapons too, and this is the whole reason the voice exists
 *
 * A weapon runs for twenty to a hundred and sixty seconds. The acoustic model gives its target
 * twenty to sixty of them — a torpedo radiates 62 dB continuously and a boat at all stop hears one
 * from over a kilometre out — but until this file voiced them, everything the player was *told* in
 * that window lasted two and a half seconds: the launch alarm, fired once at the moment the tube
 * was heard. After that a weapon closing for a minute was nine pixels on a scope the player had to
 * happen to be looking at.
 *
 * So a hostile weapon gets the same voice, and that is not free information: it is voiced only
 * while it is a **live confirmed contact** in the team's own picture (`render/picture.ts`), which
 * is the same detection machinery that decides whether to draw it. A weapon nobody has heard makes
 * no sound, and a boat that fires from beyond detection range still fires unannounced.
 *
 * Two things about a contact are unlike your own weapon, and both are honest limits rather than
 * gaps:
 *
 * - **A contact has no speed.** The picture measures a position and a heading and never a rate
 *   (planning/02 §5 — poses are never extrapolated). So the pitch comes off the *load's* cruise
 *   speed once the team has cleared `identificationThreshold` and knows which load it is, and off
 *   nothing at all before then: `WHINE_HZ_UNKNOWN`, which deliberately says only "a weapon is
 *   running". Guessing would put the reading the player most needs — how long have I got — on the
 *   one thing they have not earned yet.
 * - **A contact that slips is dropped, not held.** A stale pose is drawn hollow, and there is no
 *   hollow in audio: a positioned sound at a position the sonar no longer stands behind is simply
 *   a lie about where the weapon is. It goes quiet, which is its own kind of true.
 */

import { getWeapon, type EntityId, type TorpedoPhase, type Vec2, type WeaponId } from '@seg/shared';

import { audioContext, isMuted, type SoundPlacement } from './context.js';

/** Peak gain of one of **your** weapons' whines, at cruise, dead centre. */
const WHINE_GAIN = 0.055;

/**
 * And of one of **his**, which is louder on purpose.
 *
 * Your own weapon is a receipt — you know it is there, you put it there, and it is running away
 * from you. His is the only continuous sound in the game that means something is about to happen
 * to you, and it has to be audible under a fleet at flank and a cave full of returns. Half again
 * the friendly level is enough to separate them without either drowning the propellers.
 */
const WHINE_GAIN_HOSTILE = 0.085;

/** Where the whine sits, Hz, at the slowest and fastest speed in the weapon table. */
const WHINE_HZ_SLOW = 420;
const WHINE_HZ_FAST = 880;

/**
 * And where an **unidentified** hostile weapon sits, Hz — between the two, and pinned to neither.
 *
 * The audible half of the generic dart (`render/sonar.ts`): a team below `identificationThreshold`
 * knows a weapon is in the water and no more, so this pitch has to carry exactly that much. The
 * midpoint is chosen because it is the one value that cannot be mistaken for a reading — a whine
 * at `WHINE_HZ_SLOW` would say "you have a minute" and one at `WHINE_HZ_FAST` would say "you have
 * twenty seconds", and being wrong in either direction is worse than saying nothing.
 */
const WHINE_HZ_UNKNOWN = (WHINE_HZ_SLOW + WHINE_HZ_FAST) / 2;

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

/**
 * One weapon in the water, as the voices need to read it — **yours or his**.
 *
 * Three fields are nullable and all three are nullable for the same reason: a hostile weapon
 * reaches this file as a *sonar contact* rather than as a simulation object, and a contact is a
 * strictly poorer thing to know. See the header on what each absence is allowed to sound like.
 */
export interface TorpedoSource {
  /**
   * The weapon's entity id, or the *contact* id for a hostile one.
   *
   * The two are separate id spaces and both are plain numbers, so they can and do collide.
   * `hostile` is what keeps the voice map's keys apart (`voiceKey`) — without it your own
   * torpedo 7 and his contact 7 would take turns owning one oscillator.
   */
  readonly id: EntityId;
  /** The load, or `null` for a hostile weapon heard below `identificationThreshold`. */
  readonly weapon: WeaponId | null;
  readonly pos: Vec2;
  /**
   * m/s, or `null` for a hostile contact — the picture never measures a rate.
   *
   * For your own weapon this is the speed it is *actually* making, which is what makes the whine
   * rise as it winds out of the tube.
   */
  readonly speed: number | null;
  /**
   * Its phase, or `null` for a hostile contact.
   *
   * A contact has no phase to report and does not need one: a weapon whose run has ended stops
   * being a contact for both teams on the tick it happens (`server/match/runtime.ts`), so the
   * `spent` case this field exists to silence cannot arrive down that path.
   */
  readonly phase: TorpedoPhase | null;
  /** His, not yours. Decides the level and how the pitch is arrived at. */
  readonly hostile: boolean;
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
 *
 * Three cases, in the order they are decided:
 *
 * 1. **Spent** — silent, whoever's it is. A warhead that has gone off has no motor left.
 * 2. **No speed and no load** — an unidentified hostile contact. `WHINE_HZ_UNKNOWN`, which says
 *    a weapon is running and refuses to say how fast.
 * 3. **Everything else** — pitch off a speed. Your own weapon supplies a measured one; his
 *    supplies the cruise speed of whichever load the team has identified, which is a true fact
 *    about the weapon even though it is not a measurement of this one.
 */
export function torpedoVoicing(source: TorpedoSource): TorpedoVoicing {
  if (source.phase === 'spent') return { whineHz: WHINE_HZ_SLOW, gain: 0 };

  const def = source.weapon === null ? null : getWeapon(source.weapon);
  const speed = source.speed ?? def?.speed ?? null;
  if (speed === null) return { whineHz: WHINE_HZ_UNKNOWN, gain: WHINE_GAIN_HOSTILE };

  const span = Math.max(1e-6, FASTEST - SLOWEST);
  const fraction = Math.min(1, Math.max(0, (speed - SLOWEST) / span));
  const whineHz = WHINE_HZ_SLOW + (WHINE_HZ_FAST - WHINE_HZ_SLOW) * fraction;

  // His is flat at the hostile level. There is no wind-up to hear: by the time a weapon is loud
  // enough to be a confirmed contact it has long since left its launch phase, and fading it by a
  // speed the picture never measured would be inventing the one number this path does not have.
  if (source.hostile) return { whineHz, gain: WHINE_GAIN_HOSTILE };

  // Against its own cruise speed, so a weapon still winding out of the tube fades in rather
  // than arriving at full level — which is what makes the launch read as a launch.
  const cruise = Math.max(1e-6, def?.speed ?? speed);
  return { whineHz, gain: WHINE_GAIN * Math.min(1, speed / cruise) };
}

/**
 * The voice map's key: whose weapon, and which one.
 *
 * Entity ids and contact ids are separate spaces of plain numbers (`TorpedoSource.id`), so the
 * side has to be part of the key or two unrelated weapons will fight over one set of oscillators
 * — which sounds like a whine that jumps across the stereo field for no reason.
 */
function voiceKey(source: TorpedoSource): string {
  return `${source.hostile ? 'foe' : 'own'}:${String(source.id)}`;
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
  private readonly voices = new Map<string, Voice>();

  update(sources: readonly TorpedoSource[], place: (at: Vec2) => SoundPlacement): void {
    if (isMuted()) {
      this.release();
      return;
    }

    const ctx = audioContext();
    if (ctx === null) return;

    const at = ctx.currentTime;
    const present = new Set<string>();

    for (const source of sources) {
      // A spent weapon is still in the frames for the few seconds its detonation rings, and it
      // must not still be whining while it does. Dropped rather than silenced: it will never
      // need the voice again.
      if (source.phase === 'spent') continue;
      const key = voiceKey(source);
      present.add(key);

      const voice = this.voiceFor(ctx, key);
      if (voice === null) continue;

      const { pan, level } = place(source.pos);
      const voicing = torpedoVoicing(source);
      const reach = Math.min(1, Math.max(0, level));

      voice.tone.frequency.setTargetAtTime(voicing.whineHz, at, GLIDE_S);
      voice.beat.frequency.setTargetAtTime(voicing.whineHz * (1 + BEAT_DETUNE), at, GLIDE_S);
      voice.filter.frequency.setTargetAtTime(voicing.whineHz * WHINE_BANDWIDTH, at, GLIDE_S);
      voice.gain.gain.setTargetAtTime(voicing.gain * reach, at, GLIDE_S);
      voice.panner.pan.setTargetAtTime(Math.min(1, Math.max(-1, pan)), at, GLIDE_S);
    }

    // Anything not in this frame's list has gone: your weapon spent itself, or his contact
    // slipped and the picture no longer stands behind where it was. Both go quiet — see the
    // header on why a stale contact is not held.
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
    this.voices.set(key, voice);
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
