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
