/**
 * @seg/client/ui/hud/typing — is the keyboard already spoken for?
 *
 * Every HUD binding that listens on the window has to answer this, and they all have to answer
 * it the same way: chat opens on Enter, the fleet list selects on a digit, and both must go
 * quiet the moment the player is composing a message. One of them disagreeing would show up as
 * a chat line that selects a boat halfway through being typed.
 *
 * The rule is "is a text field already taking keystrokes", not "is anything focused". A focused
 * *button* — a fleet row still wearing the ring from a click, the menu button — must not
 * swallow anything, or the bindings stop working for the rest of the match depending on what
 * was last clicked.
 */

/** Whether the keyboard already belongs to somewhere text goes. */
export function isTyping(element: Element | null): boolean {
  if (element === null) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * The same question one level wider: is the keyboard spoken for by *anything* — a text field, or
 * a panel that has taken focus and binds keys of its own?
 *
 * The second half is what the load picker needs. It moves its highlight with the arrow keys, and
 * the arrow keys are also the scope's zoom — so without a rule, choosing a torpedo would pull the
 * camera in and out behind the panel. A focused `[role="dialog"]` is that rule, stated once
 * rather than as a list of "except while the picker is open" checks scattered across the HUD.
 *
 * Asked by the *scope*, which is the surface that answers bare letters and arrows and therefore
 * the one with something to give up. The panels do not need it: none of them is open while
 * another has focus.
 */
export function ownsKeyboard(element: Element | null): boolean {
  if (isTyping(element)) return true;
  return element !== null && element.closest('[role="dialog"], dialog') !== null;
}
