/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useLobby } from '../src/state/lobby.js';
import { useMatch } from '../src/state/match.js';
import { MatchScreen } from '../src/ui/MatchScreen.js';
import { seatMatch, stubCanvas } from './match-fixture.js';
import { ownsKeyboard } from '../src/ui/hud/typing.js';

stubCanvas();

vi.mock('../src/render/ScopeHost.js', () => ({
  ScopeHost: () => <div data-testid="scope" />,
}));

const real = { loadTube: useLobby.getState().loadTube };

afterEach(() => {
  useLobby.setState(real);
  useMatch.getState().clear();
  cleanup();
});

describe('ordering probe', () => {
  it('shows what window listeners see when Enter takes a load', async () => {
    const fixture = seatMatch();
    render(<MatchScreen />);
    const first = fixture.setup.fleet.find((boat) => boat.owner === fixture.setup.you.accountId);
    if (first === undefined) throw new Error('no boat');
    useMatch.getState().select(first.id);

    // Open the picker with shift+1: nothing armed.
    fireEvent.keyDown(window, {
      key: '!',
      code: 'Digit1',
      shiftKey: true,
    });
    const panel = await screen.findByRole('dialog');

    const seen = { pickerMounted: true, ownsKeyboard: true };
    const probe = () => {
      seen.pickerMounted = document.querySelector('.tube-picker') !== null;
      seen.ownsKeyboard = ownsKeyboard(document.activeElement);
    };
    // Registered last, so it runs after Chat's own window listener would have.
    window.addEventListener('keydown', probe);

    const button = within2(panel);
    fireEvent.keyDown(button, { key: 'Enter' });
    window.removeEventListener('keydown', probe);

    expect(seen).toEqual({ pickerMounted: false, ownsKeyboard: false });
  });
});

function within2(panel: HTMLElement): HTMLElement {
  const button = Array.from(panel.querySelectorAll('button'))[0];
  if (!(button instanceof HTMLElement)) throw new Error('no button');
  button.focus();
  return button;
}
