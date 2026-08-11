/**
 * @vitest-environment jsdom
 *
 * The debug input logger runs for the life of the app once imported (`main.tsx` pulls it in for
 * its side effect), so there is no handle to construct per test — the listeners it installs on
 * `window` are global and permanent. These tests import it once and drive it through dispatched
 * events, which is also how a developer actually uses it: from the console, on a live page.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '../src/debug/inputLog.js';

function mouseEvent(type: string, init: PointerEventInit): PointerEvent {
  return new PointerEvent(type, { pointerType: 'mouse', ...init });
}

let defaultedTo: boolean | undefined;

beforeAll(() => {
  // Captured before anything else touches the flag, so the default is asserted once below
  // without the rest of the suite having to depend on import order.
  defaultedTo = window.SEG_DEBUG_INPUT;
  window.SEG_DEBUG_INPUT = true;
});

afterEach(() => {
  window.SEG_DEBUG_INPUT = true;
  vi.restoreAllMocks();
});

describe('input debug logging', () => {
  it('is off by default, until a developer turns it on from the console', () => {
    expect(defaultedTo).toBe(false);
  });

  it('logs a keydown, tagged with the last known mouse position', () => {
    window.dispatchEvent(mouseEvent('pointermove', { clientX: 12, clientY: 34 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW' }));

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('(12, 34)');
  });

  it('never logs a pointermove on its own', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    window.dispatchEvent(mouseEvent('pointermove', { clientX: 1, clientY: 1 }));

    expect(log).not.toHaveBeenCalled();
  });

  it('logs a mouse button press and release, not just keys', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    window.dispatchEvent(mouseEvent('pointerdown', { button: 2 }));
    window.dispatchEvent(mouseEvent('pointerup', { button: 2 }));

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toContain('mousedown right');
    expect(log.mock.calls[1]?.[0]).toContain('mouseup right');
  });

  it('ignores non-mouse pointers, since a touch or pen tap is not a "key"', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    window.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch' }));

    expect(log).not.toHaveBeenCalled();
  });

  it('stays silent once turned off from the console', () => {
    window.SEG_DEBUG_INPUT = false;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
    window.dispatchEvent(mouseEvent('pointerdown', { button: 0 }));

    expect(log).not.toHaveBeenCalled();
  });

  it('picks back up the moment it is turned back on', () => {
    window.SEG_DEBUG_INPUT = false;
    window.SEG_DEBUG_INPUT = true;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA' }));

    expect(log).toHaveBeenCalledTimes(1);
  });
});
