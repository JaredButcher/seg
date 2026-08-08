/**
 * @vitest-environment jsdom
 *
 * The in-match Esc window (planning/08 §11): how it opens, what Escape means at each level,
 * and that leaving is confirmed before it fires. The store action behind Leave — and the
 * `lobby.leave` it puts on the wire — is covered in match-connection.test.ts.
 *
 * ScopeHost is mocked for the same reason as in match-screen.test.tsx: the Pixi canvas is a
 * WebGL concern jsdom has no business opening.
 */
import { generateMap } from '@seg/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLobby } from '../src/state/lobby.js';
import { useMatch } from '../src/state/match.js';
import { useNav } from '../src/state/nav.js';
import { MatchScreen } from '../src/ui/MatchScreen.js';

vi.mock('../src/render/ScopeHost.js', () => ({
  ScopeHost: () => <div data-testid="scope" />,
}));

/** jsdom does not implement <dialog>; the menu relies on showModal to reach the top layer. */
function stubDialog() {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}

const MAP = generateMap('empty', { seed: 42, mapSize: 'medium' });
const realLeaveMatch = useLobby.getState().leaveMatch;

let leaveMatch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  stubDialog();
  leaveMatch = vi.fn();
  useLobby.setState({ leaveMatch });
  useNav.setState({ screen: 'match', authTab: 'signIn' });
  useMatch.setState({
    matchId: 'm1',
    states: { m1: { t: 'match.state', matchId: 'm1', mode: 'deathmatch', map: MAP } },
  });
});

afterEach(() => {
  useLobby.setState({ leaveMatch: realLeaveMatch });
  useMatch.setState({ matchId: null, states: {} });
  cleanup();
});

/** The menu's own root, so its entries are not confused with the HUD's. */
function menu() {
  return screen.getByRole('navigation', { name: /match menu/i });
}

function isOpen(): boolean {
  return screen.queryByRole('navigation', { name: /match menu/i }) !== null;
}

/** The root entry that opens the confirmation, matched on its description so it cannot
 *  collide with the confirm button that shares its label. */
function leaveEntry() {
  return screen.getByRole('button', { name: /return to the main menu/i });
}

describe('the Esc menu', () => {
  it('is closed until the player asks for it', () => {
    render(<MatchScreen />);

    expect(isOpen()).toBe(false);
  });

  it('opens on Escape, closes on Escape, and opens again from the HUD button', async () => {
    const user = userEvent.setup();
    render(<MatchScreen />);

    await user.keyboard('{Escape}');
    expect(isOpen()).toBe(true);

    await user.keyboard('{Escape}');
    expect(isOpen()).toBe(false);

    await user.click(screen.getByRole('button', { name: /menu/i }));
    expect(isOpen()).toBe(true);
  });

  it('says the match is still running, because it is not a pause', async () => {
    const user = userEvent.setup();
    render(<MatchScreen />);
    await user.keyboard('{Escape}');

    expect(screen.getByRole('status').textContent).toMatch(/not paused/i);
  });

  it('offers exactly Resume, Settings, Controls and Leave — there is no concede', async () => {
    const user = userEvent.setup();
    render(<MatchScreen />);
    await user.keyboard('{Escape}');

    const labels = Array.from(menu().querySelectorAll('.menu__label')).map((el) => el.textContent);
    expect(labels).toEqual(['RESUME', 'SETTINGS', 'CONTROLS', 'LEAVE MATCH']);
  });

  it('resumes on Resume', async () => {
    const user = userEvent.setup();
    render(<MatchScreen />);
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: /resume/i }));

    expect(isOpen()).toBe(false);
  });

  it('opens sub-panes in place rather than navigating away from the match', async () => {
    const user = userEvent.setup();
    render(<MatchScreen />);
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: /controls/i }));

    // Still on the match screen, with the scope mounted behind the panel.
    expect(screen.getByTestId('scope')).toBeTruthy();
    expect(useNav.getState().screen).toBe('match');
    expect(screen.getByRole('heading', { name: /^controls$/i })).toBeTruthy();
    expect(screen.getByText(/open this menu, back out of a pane, or resume/i)).toBeTruthy();
  });

  it('backs a sub-pane out one level on Escape rather than resuming', async () => {
    const user = userEvent.setup();
    render(<MatchScreen />);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.getByRole('heading', { name: /^settings$/i })).toBeTruthy();

    await user.keyboard('{Escape}');

    // Back at the root, not closed — one press, one level.
    expect(isOpen()).toBe(true);
    expect(screen.queryByRole('heading', { name: /^settings$/i })).toBeNull();

    await user.keyboard('{Escape}');
    expect(isOpen()).toBe(false);
  });

  it('confirms before leaving, and staying keeps the player in the match', async () => {
    const user = userEvent.setup();
    render(<MatchScreen />);
    await user.keyboard('{Escape}');

    await user.click(leaveEntry());
    expect(leaveMatch).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /stay/i }));

    expect(leaveMatch).not.toHaveBeenCalled();
    expect(isOpen()).toBe(true);
  });

  it('explains that leaving is not conceding, then leaves once confirmed', async () => {
    const user = userEvent.setup();
    render(<MatchScreen />);
    await user.keyboard('{Escape}');

    await user.click(leaveEntry());
    // The explanation is the point of the extra step, so it is asserted, not the button.
    expect(screen.getByText(/leaving is not conceding/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /^leave match$/i }));

    expect(leaveMatch).toHaveBeenCalledTimes(1);
  });
});
