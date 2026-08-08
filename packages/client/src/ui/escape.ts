/**
 * @seg/client/ui/escape — Escape means "back", and it means one thing at a time.
 *
 * Back out of a popup; failing that, off a screen to the one behind it. Those layer — a fleet
 * picker open over the editor is two things one press could mean — so every level registers
 * here instead of hanging its own window listener, and only the innermost registered level
 * sees a press. A shared stack is what stops a single Escape from closing the dialog *and*
 * leaving the screen behind it in the same frame.
 *
 * Depth is mount order, not tree depth: a popup opens after the screen under it, so it
 * registers later and wins. That is the only ordering this needs to get right, because
 * nothing in the app mounts a popup and its backdrop screen in the same commit.
 *
 * Two places deliberately register nothing. The main menu has nowhere to go back to, and the
 * lobby has nowhere it *should* go — leaving one is a real action with its own button, and a
 * stray keypress should not drop a player out of a lobby their team is waiting in.
 */

import { useEffect, useRef } from 'react';

type Handler = () => void;

/** Innermost last. Only the last entry sees a press. */
const stack: Handler[] = [];

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;

  const innermost = stack[stack.length - 1];
  if (innermost === undefined) return;

  /*
   * Suppressed unconditionally, including for a native `<dialog>` that would have closed
   * itself on this key. Those dialogs suppress their own `cancel` and register here instead
   * (see fleet/Pickers.tsx and EscMenu.tsx), so the browser's path and ours can never both
   * run and skip two levels on one press.
   */
  event.preventDefault();
  innermost();
}

/**
 * Take Escape while this component is mounted.
 *
 * @param onEscape What back means here — close this popup, or leave this screen.
 * @param enabled  Register at all. A level that hands Escape to something it renders (the
 *                 match screen, while its menu is up) passes `false` rather than unmounting.
 */
export function useEscape(onEscape: Handler, enabled = true): void {
  /*
   * The callback is read through a ref so an ordinary re-render — a keystroke in a text
   * field, a lobby broadcast — cannot pop and re-push this level, which would quietly move
   * it above a popup that opened over it.
   */
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });

  useEffect(() => {
    if (!enabled) return;

    // A fresh identity per registration, so unmount removes this level and not an identical
    // handler registered by a sibling.
    const level: Handler = () => latest.current();
    if (stack.length === 0) window.addEventListener('keydown', onKeyDown);
    stack.push(level);

    return () => {
      const at = stack.lastIndexOf(level);
      if (at !== -1) stack.splice(at, 1);
      if (stack.length === 0) window.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled]);
}
