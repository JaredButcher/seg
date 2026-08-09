/**
 * @seg/client/audio/context — the one audio device, and the mute that silences it.
 *
 * `ping.ts` used to own all of this, when a pulse was the only sound in the game. There are three
 * voices now — the pulse, the propellers, and the transients — and they must share a context: a
 * browser allows a handful of `AudioContext`s per page and each one is a hardware claim, so a file
 * that made its own would be one voice away from failing to start on somebody's laptop.
 *
 * This is still not a mixer. The audio pass is M6 (planning/11); what it will bring is the bus
 * graph planning/08 §9 asks for — separate levels for informative, transient, and ambient audio,
 * with informative audible when the rest is turned down. Until then there is one gain stage per
 * voice and one mute for the lot.
 *
 * ## Autoplay
 *
 * A browser will not start an `AudioContext` before the player has interacted with the page. Two
 * things handle it: the context is resumed on every attempt, and a one-shot listener unlocks it on
 * the first pointer or key event. In practice the player is clicking and typing within a second of
 * the match screen appearing, and the case the guards exist for is the audio that starts *without*
 * them doing anything — a teammate's boat pinging, or a propeller, which now begins the moment a
 * frame arrives.
 */

/** Where the mute lives between sessions. */
const MUTE_KEY = 'seg.audio.muted';

/**
 * A sound's place in the picture: how far left or right, and how loud.
 *
 * Measured against the **viewport**, not against a boat. The player is not a submarine — they are
 * looking at a scope, and the camera is where they are standing (see `render/ScopeHost#soundFor`).
 * Deciding it any other way, from the selected boat say, would mean every sound in the game
 * panning when the player pressed a number key.
 */
export interface SoundPlacement {
  /** −1 hard left, 0 centred, +1 hard right. Clamped by whatever consumes it. */
  readonly pan: number;
  /** 0..1. Zero is silence, and is generally not played at all rather than played inaudibly. */
  readonly level: number;
}

let context: AudioContext | null = null;
let unlocking = false;
let muted = readMuted();

/** Whether the game is silenced. Survives a reload. */
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
 * The shared context, or `null` where there is no Web Audio at all — jsdom, an old browser, a
 * locked-down page.
 *
 * Every caller has to handle the `null`, and every caller does so by making no sound. Audio here
 * is a cue layered over a picture that already says everything; a client that cannot produce it is
 * a client that is slightly less pleasant, not a broken one.
 */
export function audioContext(): AudioContext | null {
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
 * The context, if it is ready to make a sound *right now*.
 *
 * What this adds over `audioContext` is the suspended case, and the answer to it is to nudge the
 * context and give up on this sound rather than to queue it. A one-shot cue is a *now* event; one
 * played half a second late, after the thing it belongs to has left the screen, is worse than one
 * not played at all. A continuous voice does not use this — it wants the context whether or not it
 * is running, so that it is already singing when the context resumes.
 */
export function runningContext(): AudioContext | null {
  const ctx = audioContext();
  if (ctx === null) return null;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined);
    return null;
  }
  return ctx;
}

/**
 * Drop the device. Called when the match screen goes away, so a menu holds no audio hardware.
 *
 * Anything holding nodes off this context has to be torn down *first* — the caller owns that
 * order, and in practice the caller is `ScopeHost`'s cleanup, which stops the propellers and then
 * calls this.
 */
export function releaseAudio(): void {
  const ctx = context;
  context = null;
  void ctx?.close().catch(() => undefined);
}

/**
 * Resume the context on the first user gesture after it was created.
 *
 * Registered once, and removed the moment it fires. `keydown` as well as `pointerdown` because the
 * first thing a player does in a match may well be press `Q`, and a gesture the browser accepts is
 * a gesture whether or not it came from a mouse.
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
