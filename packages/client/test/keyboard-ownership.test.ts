/**
 * @vitest-environment jsdom
 *
 * Who has the keyboard — the rule every window-level binding in the HUD asks before it acts.
 *
 * It is a two-line function and it decides whether a space between two typed words puts a torpedo
 * in the water, and whether walking the load picker with the arrow keys zooms the scope behind it.
 * Both are the kind of bug that only shows up with a panel open and a hand already busy, which is
 * exactly when nobody is in a position to notice what went wrong.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { isTyping, ownsKeyboard } from '../src/ui/hud/typing.js';

afterEach(() => {
  document.body.innerHTML = '';
});

/** Put `html` on the page and hand back the element with `id="probe"`. */
function probe(html: string): Element {
  document.body.innerHTML = html;
  const element = document.getElementById('probe');
  if (element === null) throw new Error('the fixture has no #probe');
  return element;
}

describe('isTyping', () => {
  it('is true for the places text goes', () => {
    expect(isTyping(probe('<input id="probe" />'))).toBe(true);
    expect(isTyping(probe('<textarea id="probe"></textarea>'))).toBe(true);
    // The contenteditable arm is not asserted: jsdom does not implement `isContentEditable`, so
    // a test of it here would be a test of the stub rather than of the rule.
  });

  it('is false for a focused button, and for nothing focused at all', () => {
    // A fleet row still wearing the ring from a click must not swallow the bindings for the
    // rest of the match.
    expect(isTyping(probe('<button id="probe"></button>'))).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});

describe('ownsKeyboard', () => {
  it('covers everything isTyping does', () => {
    expect(ownsKeyboard(probe('<input id="probe" />'))).toBe(true);
    expect(ownsKeyboard(null)).toBe(false);
  });

  it('is true inside a panel that has taken focus', () => {
    // The load picker: a `role="dialog"` whose arrow keys are its own, and the scope's zoom.
    expect(ownsKeyboard(probe('<div role="dialog"><button id="probe"></button></div>'))).toBe(true);
    // And the Esc window, which is a real `<dialog>` rather than a role.
    expect(ownsKeyboard(probe('<dialog open><button id="probe"></button></dialog>'))).toBe(true);
  });

  it('is false for a button that is merely on the HUD', () => {
    // The throttle notches, the tube pips, the mini-map — all focusable, none of them binding
    // a key. If this were true the bare-key commands would die on the first click.
    expect(ownsKeyboard(probe('<section><button id="probe"></button></section>'))).toBe(false);
  });
});
