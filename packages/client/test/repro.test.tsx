/**
 * @vitest-environment jsdom
 */
import { TUBE_WEAPON_IDS } from '@seg/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLobby } from '../src/state/lobby.js';
import { useMatch } from '../src/state/match.js';
import { MatchScreen } from '../src/ui/MatchScreen.js';
import { seatMatch, stubCanvas } from './match-fixture.js';

stubCanvas();

vi.mock('../src/render/ScopeHost.js', () => ({
  ScopeHost: () => <div data-testid="scope" />,
}));

const real = { loadTube: useLobby.getState().loadTube };
let loadTube: ReturnType<typeof vi.fn>;

beforeEach(() => {
  loadTube = vi.fn();
  useLobby.setState({ loadTube });
});

afterEach(() => {
  useLobby.setState(real);
  useMatch.getState().clear();
  cleanup();
});

function seated() {
  const fixture = seatMatch();
  render(<MatchScreen />);
  const first = fixture.setup.fleet.find((boat) => boat.owner === fixture.setup.you.accountId);
  if (first === undefined) throw new Error('no boat');
  useMatch.getState().select(first.id);
  return { ...fixture, boat: first };
}

function shiftDigit(digit: number): void {
  fireEvent.keyDown(window, {
    key: ')!@#$%^&*('[digit],
    code: `Digit${String(digit)}`,
    shiftKey: true,
  });
}

/*
 * Repro bug 1 was "Enter masked from chat when the picker is open": the key took a load, and the
 * chat box opened behind it. Enter has since stopped choosing loads altogether — it is chat's
 * alone, and `E` does the taking — so what is left to regress is the other half of that bug. With
 * a panel up, Enter must do *nothing*: not choose a load through the browser's own activation of
 * the focused row, and not open the chat box behind it either.
 */
describe('repro bug 1: Enter and the open picker', () => {
  it('neither takes a load nor opens chat (picker opened by shift+number)', async () => {
    seated();
    shiftDigit(1);
    const panel = await screen.findByRole('dialog');

    const button = within(panel).getAllByRole('button')[0]!;
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });

    expect(loadTube).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    // And the panel is still up, waiting for the key that does choose.
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });
});

/*
 * What was repro bug 2 — "C forces the queued load on armed tubes" — is gone with the key. `C`
 * ejected and reloaded every stale tube on the boat at once, which was the "load it now" gesture
 * from before there was a single armed tube to hang one off. Shift+E is that gesture now, aimed at
 * the tube the player has open, and it is covered in match-weapons.test.tsx where the rest of the
 * load key lives. Nothing is left here to regress.
 */

describe('repro bug 2: forcing the queued load in now', () => {
  it('empties the tube and reloads on shift+E, without a second panel opening behind it', async () => {
    const { boat } = seated();
    fireEvent.keyDown(window, { key: 'e' });
    const panel = await screen.findByRole('dialog');

    // Off the load the tube is already holding first: a swap to that would spend a full cycle to
    // change nothing, and the panel drops the flag rather than sending it.
    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    fireEvent.keyDown(panel, { key: 'e', shiftKey: true });

    expect(loadTube).toHaveBeenCalledTimes(1);
    expect(loadTube).toHaveBeenCalledWith(boat.id, 0, TUBE_WEAPON_IDS[1], true);
    // Taking a load shuts the panel, and the press must not reach the window binding that would
    // put a fresh one straight back up.
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
