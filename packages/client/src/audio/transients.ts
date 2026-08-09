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
 * Only two of the kinds can currently fire — `bottoming` when a boat hits terrain and `collision`
 * when two hulls meet (`sim/collision`). The rest are here because the plumbing that carries them
 * is generic: the day torpedoes launch, the launch is audible without touching this file.
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
  'torpedo-launch': {
    thumpHz: 210,
    thumpEndHz: 120,
    noiseHz: 900,
    noiseKind: 'bandpass',
    seconds: 1.1,
    gain: 0.4,
    body: 0.3,
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
  if (isMuted() || sound.level <= 0) return;

  const ctx = runningContext();
  if (ctx === null) return;
  const buffer = noiseBuffer(ctx);
  if (buffer === null) return;

  const voice = VOICES[kind];
  const at = ctx.currentTime;
  const peak =
    voice.gain * Math.min(1, Math.max(0, sound.level)) * Math.min(1, Math.max(0, weight));

  const panner = ctx.createStereoPanner();
  panner.pan.setValueAtTime(Math.min(1, Math.max(-1, sound.pan)), at);
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
