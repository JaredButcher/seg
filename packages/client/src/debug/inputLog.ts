/**
 * @seg/client/debug/inputLog — console logging for keyboard and mouse-button input.
 *
 * Every keydown/keyup and mouse-button press/release is logged with the cursor's last known
 * position, so a report like "the shot didn't fire" can be replayed from the console instead
 * of guessed at. Pointer *movement* is deliberately never logged — a drag or a pan would drown
 * the console in noise that a screen recording says better; the position is only ever attached
 * as context on a key or button event.
 *
 * Toggled from the devtools console via `window.SEG_DEBUG_INPUT` rather than a build flag or a
 * Settings checkbox: this is for a developer with the console already open, not a player. Read
 * fresh on every event rather than cached, so flipping it takes effect on the very next
 * keystroke. Off by default — a developer who wants it turns it on for the session, rather than
 * every player's console getting a firehose of keystrokes.
 */

export {};

declare global {
  interface Window {
    SEG_DEBUG_INPUT?: boolean;
  }
}

if (window.SEG_DEBUG_INPUT === undefined) window.SEG_DEBUG_INPUT = false;

function enabled(): boolean {
  return window.SEG_DEBUG_INPUT === true;
}

/** Last known cursor position, tracked silently — a move never logs anything on its own. */
let mouseX = 0;
let mouseY = 0;

function onPointerMove(event: PointerEvent): void {
  mouseX = event.clientX;
  mouseY = event.clientY;
}

const MOUSE_BUTTONS: Record<number, string> = {
  0: 'left',
  1: 'middle',
  2: 'right',
  3: 'back',
  4: 'forward',
};

function onKeyDown(event: KeyboardEvent): void {
  if (!enabled()) return;
  console.log(
    `[seg:input] keydown ${event.key} (${event.code})${event.repeat ? ' repeat' : ''} @ (${mouseX}, ${mouseY})`,
    { ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey },
  );
}

function onKeyUp(event: KeyboardEvent): void {
  if (!enabled()) return;
  console.log(`[seg:input] keyup ${event.key} (${event.code}) @ (${mouseX}, ${mouseY})`);
}

/** Mouse buttons only — a touch or pen tap is not a "key" in the sense this logs. */
function onPointerDown(event: PointerEvent): void {
  if (!enabled() || event.pointerType !== 'mouse') return;
  const button = MOUSE_BUTTONS[event.button] ?? `button${event.button}`;
  console.log(`[seg:input] mousedown ${button} @ (${mouseX}, ${mouseY})`);
}

function onPointerUp(event: PointerEvent): void {
  if (!enabled() || event.pointerType !== 'mouse') return;
  const button = MOUSE_BUTTONS[event.button] ?? `button${event.button}`;
  console.log(`[seg:input] mouseup ${button} @ (${mouseX}, ${mouseY})`);
}

window.addEventListener('pointermove', onPointerMove);
window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);
window.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointerup', onPointerUp);
