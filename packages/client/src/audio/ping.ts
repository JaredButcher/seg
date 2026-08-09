/**
 * @seg/client/audio/ping — the sound an active pulse makes, placed in the stereo field.
 *
 * The first audio in the project, and deliberately the smallest thing that could be one: a pulse
 * is a short tone with a falling pitch and a fast decay, synthesized per event through a
 * `StereoPannerNode`. The device, the mute, and the autoplay unlock moved to `context.ts` when the
 * propellers and the transients arrived and needed to share them; what is left here is the voice.
 *
 * ## Where the direction comes from
 *
 * **From the viewport, not from a boat** — see `SoundPlacement`. That geometry is not this file's
 * business: it is `ScopeHost`'s, which is the only thing that knows where the camera is. What
 * arrives here is a pan and a level.
 */

import { runningContext, isMuted, type SoundPlacement } from './context.js';

/** Peak gain of one pulse, before distance attenuation. Well under unity: this is a cue. */
const PING_GAIN = 0.22;

/** The tone falls from here to `PING_TONE_END_HZ` over its life. */
const PING_TONE_HZ = 1_150;
const PING_TONE_END_HZ = 760;

/** Attack and total length, seconds. Short enough to read as a click with a tail. */
const PING_ATTACK_S = 0.008;
const PING_LENGTH_S = 0.55;

/** One pulse, as the caller has already placed it. */
export type PingSound = SoundPlacement;

/** Play one pulse. Silently does nothing where there is no Web Audio (see `audioContext`). */
export function playPing(sound: PingSound): void {
  if (isMuted() || sound.level <= 0) return;

  const ctx = runningContext();
  if (ctx === null) return;

  const at = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const panner = ctx.createStereoPanner();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(PING_TONE_HZ, at);
  osc.frequency.exponentialRampToValueAtTime(PING_TONE_END_HZ, at + PING_LENGTH_S);

  // Exponential decay rather than linear, and never to exactly zero — `exponentialRamp` is
  // undefined at zero, and 1/10000 of the peak is inaudible anyway.
  const peak = PING_GAIN * Math.min(1, Math.max(0, sound.level));
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(peak, at + PING_ATTACK_S);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + PING_LENGTH_S);

  panner.pan.setValueAtTime(Math.min(1, Math.max(-1, sound.pan)), at);

  osc.connect(gain).connect(panner).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + PING_LENGTH_S);
  // Nodes are single-use and hold the graph alive until they finish; dropping the edges on
  // `ended` is what stops a thirty-minute match accumulating eighteen hundred dead oscillators.
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
    panner.disconnect();
  };
}
