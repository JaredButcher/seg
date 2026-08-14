/**
 * @seg/client/audio/transients — the bangs.
 *
 * planning/03 §3's transients are one-shot noise events: loud, brief, and *identifiable*. They reach
 * the acoustic model as levels power-summed onto a boat's source level, and they reach the player
 * as the sounds in this file. **Both from the same event** — `BoatState.transients`, carried on the
 * wire and read here — which is the property worth protecting: the thud a player hears and the
 * +30 dB the enemy's sonar hears are the same fact, not two systems that have to be kept in step.
 *
 * ## One synth, a table of voices
 *
 * Every transient in the game is the same shape: a pitched thump that falls, plus a burst of
 * filtered noise, both decaying over a fraction of a second. What distinguishes a hull scraping
 * rock from a torpedo leaving a tube is where those two sit and how long they last, so the
 * difference is a row in a table rather than a function per kind.
 *
 * Six of the kinds can currently fire: `bottoming` when a boat hits terrain, `collision` when two
 * hulls meet (`sim/collision`), and `torpedo-launch`, `torpedo-detonation`, `hull-damage`, and
 * `hull-destroyed` from the weapons phase (`sim/weapons`). The rest are here because the plumbing
 * that carries them is generic — the day a boat breaches the surface, it is audible without
 * touching this file.
 *
 * ## The impact is deliberately the deepest one
 *
 * Hitting rock is the loudest thing in the transient table (+30 dB, planning/03 §3) and it should
 * be the thing the player feels rather than merely notices — it is the punishment for careless
 * piloting, and the boat has just stopped and lost its orders. So it is low, long, and blunt, and
 * the hull-to-hull collision is a shorter, harder version of the same voice: rock does not give and
 * a hull does.
 */

import type { TransientKind } from '@seg/shared';

import { runningContext, isMuted, type SoundPlacement } from './context.js';

/** How one kind of transient sounds. See the header on why this is a table. */
interface TransientVoice {
  /** The thump's pitch at the instant of the event and at the end of it, Hz. */
  readonly thumpHz: number;
  readonly thumpEndHz: number;
  /** Where the noise burst sits, Hz, and whether it is shaped as a thud or as a hiss. */
  readonly noiseHz: number;
  readonly noiseKind: 'lowpass' | 'bandpass';
  /** How long the whole thing takes, seconds. */
  readonly seconds: number;
  /** Peak gain before size and placement. Under unity — these are cues, not stings. */
  readonly gain: number;
  /** How much of the peak is thump rather than noise, 0..1. */
  readonly body: number;
}

const VOICES: Readonly<Record<TransientKind, TransientVoice>> = {
  /** Rock. Deep, blunt, and the longest of them — see the header. */
  bottoming: {
    thumpHz: 92,
    thumpEndHz: 41,
    noiseHz: 380,
    noiseKind: 'lowpass',
    seconds: 0.95,
    gain: 0.5,
    body: 0.7,
  },
  /** Hull against hull. The same impact, harder and shorter, with more metal in it. */
  collision: {
    thumpHz: 140,
    thumpEndHz: 62,
    noiseHz: 760,
    noiseKind: 'bandpass',
    seconds: 0.7,
    gain: 0.44,
    body: 0.55,
  },
  'hull-damage': {
    thumpHz: 165,
    thumpEndHz: 70,
    noiseHz: 1_100,
    noiseKind: 'bandpass',
    seconds: 0.8,
    gain: 0.46,
    body: 0.5,
  },
  /**
   * The hull giving way for the last time — lower and longer than an ordinary hit, and closer
   * in character to a small version of the warhead voice below it than to `hull-damage`'s
   * scrape. Short of `torpedo-detonation` in every figure, on purpose: that stays the loudest
   * and longest voice in the table.
   */
  'hull-destroyed': {
    thumpHz: 100,
    thumpEndHz: 34,
    noiseHz: 480,
    noiseKind: 'lowpass',
    seconds: 1.3,
    gain: 0.6,
    body: 0.68,
  },
  /**
   * A tube firing: the impulse charge, then the rush of water. Mostly noise rather than thump,
   * which is what makes it read as a *release* instead of an impact.
   */
  'torpedo-launch': {
    thumpHz: 210,
    thumpEndHz: 120,
    noiseHz: 900,
    noiseKind: 'bandpass',
    seconds: 1.1,
    gain: 0.4,
    body: 0.3,
  },
  /**
   * The countermeasure hatch: a short, dry clack and a swallow of water, and then nothing.
   *
   * Deliberately the **smallest** voice in the table — a third of a torpedo launch's level and
   * shorter than any other entry — because the acoustic table says the same thing about it
   * (`content/acoustics.ts`, +2 against a launch's +25) and the two have to agree. What the player
   * is being told is "the launcher fired", not "something is happening": the *something* arrives a
   * beat later as the noisemaker's own voice, which is the loudest continuous thing in the mix
   * (`audio/noisemaker.ts`), and a big bang here would step on its entrance.
   *
   * Almost pure thump, which is what makes it read as a mechanism rather than as water — a hatch
   * and a spring, high and hard and gone.
   */
  'countermeasure-drop': {
    thumpHz: 320,
    thumpEndHz: 190,
    noiseHz: 1_400,
    noiseKind: 'bandpass',
    seconds: 0.4,
    gain: 0.26,
    body: 0.62,
  },
  /**
   * A warhead. The loudest and longest voice in the table by a clear margin, and the only one
   * that is allowed to be — it is the only event in the game that *is* the consequence rather
   * than a hint of one, and the acoustic table agrees with it at +45 dB over the base.
   *
   * Very low and very slow: the thump falls almost two octaves over a second and a half, which
   * is what a big underwater explosion does and what nothing else here does. Nearly all body,
   * so it is felt through a laptop speaker rather than heard as a hiss.
   */
  'torpedo-detonation': {
    thumpHz: 74,
    thumpEndHz: 22,
    noiseHz: 240,
    noiseKind: 'lowpass',
    seconds: 1.6,
    gain: 0.7,
    body: 0.78,
  },
  'emergency-blow': {
    thumpHz: 120,
    thumpEndHz: 90,
    noiseHz: 1_800,
    noiseKind: 'bandpass',
    seconds: 1.4,
    gain: 0.34,
    body: 0.2,
  },
  'hard-turn': {
    thumpHz: 110,
    thumpEndHz: 80,
    noiseHz: 600,
    noiseKind: 'lowpass',
    seconds: 0.9,
    gain: 0.24,
    body: 0.35,
  },
  'surface-breach': {
    thumpHz: 150,
    thumpEndHz: 60,
    noiseHz: 2_400,
    noiseKind: 'bandpass',
    seconds: 1.2,
    gain: 0.42,
    body: 0.25,
  },
};

/**
 * The two hull events, as heard from **inside the hull they happened to**.
 *
 * `VOICES` above describes a bang crossing open water: filtered by distance, placed in the stereo
 * field, scaled down by how far away it was. That is right for every hit in the match except the
 * ones that land on the boat the player is commanding, and for those it is badly wrong — it makes
 * being torpedoed sound like watching someone else be torpedoed from four hundred metres away.
 *
 * So the same event gets a second voice down a second path (`playHullShock`), and every figure
 * moves the same way: **lower, longer, more body, and much louder**. That is not a mix decision
 * dressed up as physics — it is what a structural impact on the hull around you actually is
 * against one propagated through a kilometre of water. The high end is gone because water ate it;
 * what is left is the part you feel.
 *
 * It is **unplaced**, and that is the load-bearing half. Every other sound in the game is panned
 * and levelled by where it is relative to the camera, because every other sound is a thing over
 * *there*. This one has no bearing to give: the player is inside it, so it arrives centred at full
 * level whatever the camera happens to be looking at — which is exactly the case the whole feature
 * exists for, a player scrolled away across the map when their boat is hit.
 */
const INBOARD: Readonly<Record<HullShockKind, TransientVoice>> = {
  /**
   * A hit. Nearly an octave below the waterborne version and twice as long, with the bandpass
   * scrape replaced by a lowpass boom — you do not hear the grind of a warhead through your own
   * pressure hull, you hear the hull answer it.
   */
  'hull-damage': {
    thumpHz: 96,
    thumpEndHz: 38,
    noiseHz: 640,
    noiseKind: 'lowpass',
    seconds: 1.5,
    gain: 0.9,
    body: 0.72,
  },
  /**
   * The last one. Longer and lower than anything else this file can produce, `torpedo-detonation`
   * included — that voice is the loudest thing in the *water*, and this is the loudest thing in
   * the game, because it is the only sound that means the match is over for this boat.
   */
  'hull-destroyed': {
    thumpHz: 66,
    thumpEndHz: 20,
    noiseHz: 300,
    noiseKind: 'lowpass',
    seconds: 2.4,
    gain: 1,
    body: 0.8,
  },
};

/** Seconds of noise generated per burst. Short: it is a burst. */
const NOISE_SECONDS = 1.5;

let noise: AudioBuffer | null = null;
let noiseFor: AudioContext | null = null;

/**
 * Play one transient.
 *
 * `weight` is how big the boat that made it is (`hullWeight`) — a Light hitting a wall is not a
 * Heavy hitting a wall, and the acoustic model says as much through the boat's own source level.
 * Placement is the caller's, as it is for every other voice.
 */
export function playTransient(kind: TransientKind, sound: SoundPlacement, weight = 1): void {
  if (sound.level <= 0) return;
  strike(VOICES[kind], sound.pan, Math.min(1, Math.max(0, sound.level)) * clamp01(weight));
}

/**
 * The two kinds of thing that can happen to a hull, as `playHullShock` reads them.
 *
 * A subset of `TransientKind` rather than a type of its own, because they *are* those two events —
 * the same `BoatTransient` off the same wire, heard from the other side of the hull plating.
 */
export type HullShockKind = 'hull-damage' | 'hull-destroyed';

/**
 * Play one hull event as the boat the player is commanding heard it.
 *
 * The counterpart of `playTransient` and deliberately not a flag on it: there is no
 * `SoundPlacement` in the signature at all, because there is no placement to give. See `INBOARD`.
 *
 * **It replaces the waterborne cue rather than joining it.** The caller plays one or the other,
 * never both — power-summing a hull failing onto the sound of the hit that failed it would be
 * counting one event twice, which is the same argument `sim/weapons/phase.ts#hurt` makes about the
 * transients themselves.
 */
export function playHullShock(kind: HullShockKind): void {
  // No `weight`, unlike `playTransient`, and no placement. Both of those scale a bang by how far
  // away and how big the thing that made it was; neither question has an answer when the thing
  // that made it is the hull you are sitting in. A Light being holed is as loud as a Heavy being
  // holed, because in both cases it is *your* boat and you are inside it.
  strike(INBOARD[kind], 0, 1);
}

/** The synth both paths share: a falling thump plus a filtered burst, on one envelope. */
function strike(voice: TransientVoice, pan: number, level: number): void {
  if (isMuted()) return;

  const ctx = runningContext();
  if (ctx === null) return;
  const buffer = noiseBuffer(ctx);
  if (buffer === null) return;

  const at = ctx.currentTime;
  const peak = voice.gain * clamp01(level);

  const panner = ctx.createStereoPanner();
  panner.pan.setValueAtTime(Math.min(1, Math.max(-1, pan)), at);
  panner.connect(ctx.destination);

  // ── the thump: a sine dropping through the event ──────────────────────────────
  const thump = ctx.createOscillator();
  const thumpGain = ctx.createGain();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(voice.thumpHz, at);
  thump.frequency.exponentialRampToValueAtTime(voice.thumpEndHz, at + voice.seconds);
  envelope(thumpGain.gain, peak * voice.body, at, voice.seconds);
  thump.connect(thumpGain).connect(panner);

  // ── the noise: the grind, the scrape, the water ───────────────────────────────
  const burst = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const burstGain = ctx.createGain();
  burst.buffer = buffer;
  filter.type = voice.noiseKind;
  filter.frequency.setValueAtTime(voice.noiseHz, at);
  filter.Q.setValueAtTime(voice.noiseKind === 'bandpass' ? 0.8 : 0.7, at);
  envelope(burstGain.gain, peak * (1 - voice.body), at, voice.seconds);
  burst.connect(filter).connect(burstGain).connect(panner);

  thump.start(at);
  burst.start(at);
  thump.stop(at + voice.seconds);
  burst.stop(at + voice.seconds);

  // The nodes hold the graph alive until they finish, so the edges come down when the sound does.
  // Without this a long match accumulates a dead oscillator per bang.
  burst.onended = () => {
    thump.disconnect();
    thumpGain.disconnect();
    burst.disconnect();
    filter.disconnect();
    burstGain.disconnect();
    panner.disconnect();
  };
}

/** Into `0 … 1`. Both scalars a strike is built from are fractions and neither caller is trusted. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * A percussive envelope: effectively instant attack, exponential decay.
 *
 * Never ramps to exactly zero — `exponentialRampToValueAtTime` is undefined there — and a
 * ten-thousandth of the peak is inaudible. The 4 ms attack is what stops the click a hard start
 * from zero produces.
 */
function envelope(param: AudioParam, peak: number, at: number, seconds: number): void {
  const floor = Math.max(1e-4, peak * 1e-4);
  param.setValueAtTime(floor, at);
  param.linearRampToValueAtTime(Math.max(floor, peak), at + 0.004);
  param.exponentialRampToValueAtTime(floor, at + seconds);
}

/** The white noise every burst is filtered out of. One buffer, remade only if the device changes. */
function noiseBuffer(ctx: AudioContext): AudioBuffer | null {
  if (noise !== null && noiseFor === ctx) return noise;

  try {
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1;
    noise = buffer;
    noiseFor = ctx;
    return buffer;
  } catch {
    return null;
  }
}
