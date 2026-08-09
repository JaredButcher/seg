/**
 * @vitest-environment jsdom
 */
import { DEPLOYABLE_WEAPON_IDS, type WeaponId } from '@seg/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

function queueNext(boatId: number, index: number, weapon: WeaponId): void {
  act(() => {
    useMatch.setState((state) => {
      const matchId = state.matchId ?? '';
      const view = state.views[matchId];
      if (view === undefined) return state;
      return {
        views: {
          ...state.views,
          [matchId]: {
            ...view,
            own: view.own.map((own) =>
              own.id === boatId
                ? {
                    ...own,
                    tubes: own.tubes.map((tube) =>
                      tube.index === index ? { ...tube, next: weapon } : tube,
                    ),
                  }
                : own,
            ),
          },
        },
      };
    });
  });
}

describe('repro bug 1: Enter masked from chat when picker open', () => {
  it('takes a load on Enter without opening chat (picker opened by shift+number, nothing armed)', async () => {
    const { boat } = seated();
    shiftDigit(1);
    const panel = await screen.findByRole('dialog');

    const button = within(panel).getAllByRole('button')[0]!;
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });

    expect(loadTube).toHaveBeenCalledWith(boat.id, 0, DEPLOYABLE_WEAPON_IDS[0], false);
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });
});

describe('repro bug 2: C forces the queued load on armed tubes', () => {
  it('swaps every armed loaded tube with a different queued load', () => {
    const { boat } = seated();
    queueNext(boat.id, 0, 'super-cavitating');
    queueNext(boat.id, 1, 'super-cavitating');
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });

    fireEvent.keyDown(window, { key: 'c' });

    expect(loadTube).toHaveBeenCalledTimes(2);
    expect(loadTube).toHaveBeenCalledWith(boat.id, 0, 'super-cavitating', true);
    expect(loadTube).toHaveBeenCalledWith(boat.id, 1, 'super-cavitating', true);
  });
});
