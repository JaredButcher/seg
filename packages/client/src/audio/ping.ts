/**
 * @seg/client/audio/ping — the sound an active pulse makes, placed in the stereo field.
 *
 * The first audio in the project, and deliberately the smallest thing that could be one: no
 * asset pipeline, no mixer, no bus graph. A pulse is a short tone with a falling pitch and a
 * fast decay, synthesized per event through a `StereoPannerNode`, and that is the whole file.
 * The audio pass is M6 (planning/11); when it arrives this becomes one voice on a bus rather
 * than the thing that owns the context.
 *
 * ## Where the direction comes from
 *
 * **From the viewport, not from a boat.** The player is not a submarine — they are looking at a
 * scope, and the camera is where they are standing. So a pulse off the left edge of the screen
 * is heard on the left, one in the middle is heard in the middle, and one far off screen is
 * heard faintly or not at all. Deciding it any other way (from the selected boat, say) would
 * mean the sound moving when the player pressed a number key, which is exactly the sort of
 * thing that reads as a bug rather than as a cue.
 *
 * That geometry is not this file's business — it is `ScopeHost`'s, which is the only thing that
 * knows where the camera is. What arrives here is a pan and a level.
 *
 * ## Autoplay
 *
 * A browser will not start an `AudioContext` before the player has interacted with the page.
 * Two things handle it: the context is resumed on every attempt, and a one-shot listener unlocks
 * it on the first pointer or key event. In practice the player switches their own sonar on with
 * a click or a keypress, which is itself the gesture — the case these guards exist for is a
 * *teammate's* boat pinging before this player has touched anything.
 */

/** Peak gain of one pulse, before distance attenuation. Well under unity: this is a cue. */
const PING_GAIN = 0.22;

/** The tone falls from here to `PING_TONE_END_HZ` over its life. */
const PING_TONE_HZ = 1_150;
const PING_TONE_END_HZ = 760;

/** Attack and total length, seconds. Short enough to read as a click with a tail. */
const PING_ATTACK_S = 0.008;
const PING_LENGTH_S = 0.55;

/** Where the mute lives between sessions. */
const MUTE_KEY = 'seg.audio.muted';

/** One pulse, as the caller has already placed it. */
export interface PingSound {
  /** −1 hard left, 0 centred, +1 hard right. Clamped. */
  readonly pan: number;
  /** 0..1. Zero is silence, and is not played at all rather than played inaudibly. */
  readonly level: number;
}

let context: AudioContext | null = null;
let unlocking = false;
let muted = readMuted();

/** Whether pulses are silenced. Survives a reload. */
export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    globalThis.localStorage?.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    // A blocked or full storage is not a reason to refuse to change the volume.
  }
}

/**
 * Play one pulse.
 *
 * Silently does nothing where there is no Web Audio at all — jsdom, an old browser, a locked-
 * down context. Sound is a cue layered over a picture that already says everything; a client
 * that cannot make it is a client that is slightly less pleasant, not a broken one.
 */
export function playPing(sound: PingSound): void {
  if (muted || sound.level <= 0) return;

  const ctx = ensureContext();
  if (ctx === null) return;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined);
    // Dropped rather than queued. A pulse is a *now* event; one played half a second late,
    // after the ring it belongs to has left the screen, is worse than one not played.
    return;
  }

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

/** Drop the context. Called when the match screen goes away, so a menu holds no audio device. */
export function releasePingAudio(): void {
  const ctx = context;
  context = null;
  void ctx?.close().catch(() => undefined);
}

// ── internals ─────────────────────────────────────────────────────────────────────

function ensureContext(): AudioContext | null {
  if (context !== null) return context;
  const Ctor = globalThis.AudioContext;
  if (typeof Ctor !== 'function') return null;

  try {
    context = new Ctor();
  } catch {
    return null;
  }
  armUnlock();
  return context;
}

/**
 * Resume the context on the first user gesture after it was created.
 *
 * Registered once, and removed the moment it fires. `keydown` as well as `pointerdown` because
 * the first thing a player does in a match may well be press `Q`, and a gesture the browser
 * accepts is a gesture whether or not it came from a mouse.
 */
function armUnlock(): void {
  if (unlocking || typeof window === 'undefined') return;
  unlocking = true;

  const unlock = (): void => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
    unlocking = false;
    void context?.resume().catch(() => undefined);
  };

  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

function readMuted(): boolean {
  try {
    return globalThis.localStorage?.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}
