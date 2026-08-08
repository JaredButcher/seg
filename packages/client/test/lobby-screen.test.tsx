/**
 * @vitest-environment jsdom
 *
 * The lobby screen's host/non-host split, and the save/revert draft model.
 *
 * The store is driven directly rather than through a socket: what these cover is which
 * controls a given player gets and what Save actually sends, and a real WebSocket would only
 * add flake. The socket round trip is covered server-side in gateway.test.ts.
 */
import type { LobbyMember, LobbySettings, LobbyState } from '@seg/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuth } from '../src/state/auth.js';
import { useLobby } from '../src/state/lobby.js';
import { LobbyScreen } from '../src/ui/LobbyScreen.js';

const HOST = { id: 'host-1', username: 'Skipper', createdAt: 0 };
const GUEST = { id: 'guest-1', username: 'Bosun', createdAt: 0 };

const DEFAULT_SETTINGS: LobbySettings = {
  name: 'Abyssal Trench',
  maxPlayers: 6,
  mode: 'objective-capture',
  fleetPoints: 500,
  visibility: 'public',
};

function member(id: string, username: string, position: LobbyMember['position']): LobbyMember {
  return { occupant: { kind: 'human', accountId: id }, username, position, joinedAt: 0 };
}

function lobbyState(overrides: Partial<LobbyState> = {}): LobbyState {
  return {
    id: 'lobby-1',
    code: 'BCDFGH',
    hostAccountId: HOST.id,
    settings: DEFAULT_SETTINGS,
    members: [member(HOST.id, 'Skipper', 'team1'), member(GUEST.id, 'Bosun', 'team2')],
    createdAt: 0,
    ...overrides,
  };
}

/** Signs in as `account` and puts `lobby` in the store, without touching the network. */
function seat(account: typeof HOST, lobby: LobbyState) {
  useAuth.setState({ status: 'signedIn', account, session: null });
  useLobby.setState({ lobby, status: 'open', rejection: null, exitNotice: null });
}

const modify = vi.fn();
const kick = vi.fn();
const setPosition = vi.fn();
const leave = vi.fn();

beforeEach(() => {
  modify.mockClear();
  kick.mockClear();
  setPosition.mockClear();
  leave.mockClear();
  useLobby.setState({ modify, kick, setPosition, leave });
});

afterEach(cleanup);

/** jest-dom is not wired into this project's vitest setup, so assert on the DOM directly. */
function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLInputElement | HTMLButtonElement).disabled === true;
}

/** The Players panel, so member queries do not also match the settings panel. */
function players() {
  return screen.getByRole('heading', { name: 'Players' }).closest('section') as HTMLElement;
}

describe('as the host', () => {
  beforeEach(() => seat(HOST, lobbyState()));

  it('shows a kick button for every other member', () => {
    render(<LobbyScreen />);
    const buttons = within(players()).getAllByRole('button', {
      name: /^Remove .* from the lobby$/,
    });

    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Remove Bosun from the lobby');
  });

  it('does not offer a kick button on its own row', () => {
    render(<LobbyScreen />);
    expect(within(players()).queryByRole('button', { name: /Remove Skipper/ })).toBeNull();
  });

  it('sends the account id of the player it kicked', async () => {
    const user = userEvent.setup();
    render(<LobbyScreen />);

    await user.click(screen.getByRole('button', { name: 'Remove Bosun from the lobby' }));

    expect(kick).toHaveBeenCalledWith(GUEST.id);
  });

  it('can operate every settings control', () => {
    render(<LobbyScreen />);
    for (const el of screen.getAllByRole('slider')) expect(isDisabled(el)).toBe(false);
    for (const el of screen.getAllByRole('radio')) expect(isDisabled(el)).toBe(false);
    expect(isDisabled(screen.getByLabelText('Lobby name'))).toBe(false);
  });

  it('starts with Save and Revert disabled, because nothing has changed', () => {
    render(<LobbyScreen />);
    expect(isDisabled(screen.getByRole('button', { name: 'SAVE' }))).toBe(true);
    expect(isDisabled(screen.getByRole('button', { name: 'REVERT' }))).toBe(true);
  });

  it('enables Save once a slider moves, and marks the changed setting', async () => {
    render(<LobbyScreen />);
    const players = screen.getByRole('slider', { name: /players/i });

    // fireEvent, not userEvent: a range input cannot be dragged by keyboard simulation.
    fireEvent.change(players, { target: { value: '10' } });

    expect(isDisabled(screen.getByRole('button', { name: 'SAVE' }))).toBe(false);
    expect(screen.getByText('5v5 · 10 total')).toBeDefined();
    expect(screen.getByLabelText('unsaved change')).toBeDefined();
  });

  it('sends the whole draft on Save', async () => {
    const user = userEvent.setup();
    render(<LobbyScreen />);

    fireEvent.change(screen.getByRole('slider', { name: /players/i }), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByRole('slider', { name: /fleet budget/i }), {
      target: { value: '900' },
    });
    await user.click(screen.getByRole('radio', { name: 'Deathmatch' }));
    await user.click(screen.getByRole('button', { name: 'SAVE' }));

    expect(modify).toHaveBeenCalledWith({
      name: 'Abyssal Trench',
      maxPlayers: 10,
      fleetPoints: 900,
      mode: 'deathmatch',
      visibility: 'public',
    });
  });

  it('throws the draft away on Revert without sending anything', async () => {
    const user = userEvent.setup();
    render(<LobbyScreen />);

    fireEvent.change(screen.getByRole('slider', { name: /players/i }), {
      target: { value: '16' },
    });
    expect(screen.getByText('8v8 · 16 total')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'REVERT' }));

    expect(screen.getByText('3v3 · 6 total')).toBeDefined();
    expect(modify).not.toHaveBeenCalled();
    expect(isDisabled(screen.getByRole('button', { name: 'SAVE' }))).toBe(true);
  });

  it('refuses to send an invalid lobby name', async () => {
    const user = userEvent.setup();
    render(<LobbyScreen />);

    const name = screen.getByLabelText('Lobby name');
    await user.clear(name);
    await user.type(name, 'no');
    await user.click(screen.getByRole('button', { name: 'SAVE' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(modify).not.toHaveBeenCalled();
  });

  it('keeps unsaved edits when someone else joins', () => {
    const { rerender } = render(<LobbyScreen />);
    const slider = screen.getByRole('slider', { name: /players/i });

    // Host starts editing.
    fireEvent.change(slider, { target: { value: '10' } });
    expect(screen.getByText('5v5 · 10 total')).toBeDefined();

    // A third player joins: a fresh lobby.state arrives with identical settings.
    useLobby.setState({
      lobby: lobbyState({
        members: [
          member(HOST.id, 'Skipper', 'team1'),
          member(GUEST.id, 'Bosun', 'team2'),
          member('third', 'Cook', 'team1'),
        ],
      }),
    });
    rerender(<LobbyScreen />);

    // The half-finished edit must survive — otherwise Revert means nothing and the host
    // watches their slider jump back mid-drag.
    expect(screen.getByText('5v5 · 10 total')).toBeDefined();
  });

  it('adopts new settings from the server when it has nothing unsaved', () => {
    const { rerender } = render(<LobbyScreen />);
    expect(screen.getByText('500 points')).toBeDefined();

    useLobby.setState({
      lobby: lobbyState({ settings: { ...DEFAULT_SETTINGS, fleetPoints: 1200 } }),
    });
    rerender(<LobbyScreen />);

    expect(screen.getByText('1200 points')).toBeDefined();
  });
});

describe('as a non-host', () => {
  beforeEach(() => seat(GUEST, lobbyState()));

  it('sees no kick buttons at all', () => {
    render(<LobbyScreen />);
    expect(within(players()).queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('sees every setting and its value, read-only', () => {
    render(<LobbyScreen />);

    // Visible, so a player can judge the lobby before staying — but not editable.
    expect(screen.getByText('3v3 · 6 total')).toBeDefined();
    expect(screen.getByText('500 points')).toBeDefined();
    for (const el of screen.getAllByRole('slider')) expect(isDisabled(el)).toBe(true);
    for (const el of screen.getAllByRole('radio')) expect(isDisabled(el)).toBe(true);
    expect(isDisabled(screen.getByLabelText('Lobby name'))).toBe(true);
  });

  it('gets no Save or Revert buttons', () => {
    render(<LobbyScreen />);
    expect(screen.queryByRole('button', { name: 'SAVE' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'REVERT' })).toBeNull();
  });

  it('can still change its own position and leave', async () => {
    const user = userEvent.setup();
    render(<LobbyScreen />);

    await user.click(screen.getByRole('button', { name: 'SPECTATING' }));
    expect(setPosition).toHaveBeenCalledWith('spectator');

    await user.click(screen.getByRole('button', { name: 'LEAVE LOBBY' }));
    expect(leave).toHaveBeenCalled();
  });

  it('gains the host controls when promoted', () => {
    const { rerender } = render(<LobbyScreen />);
    expect(screen.queryByRole('button', { name: 'SAVE' })).toBeNull();

    // The old host left; the server made this player the host.
    useLobby.setState({
      lobby: lobbyState({
        hostAccountId: GUEST.id,
        members: [member(GUEST.id, 'Bosun', 'team2')],
      }),
    });
    rerender(<LobbyScreen />);

    expect(screen.getByRole('button', { name: 'SAVE' })).toBeDefined();
    for (const el of screen.getAllByRole('slider')) expect(isDisabled(el)).toBe(false);
  });
});

describe('the roster', () => {
  it('marks who you are and who the host is', () => {
    seat(GUEST, lobbyState());
    render(<LobbyScreen />);

    const rows = within(players()).getAllByRole('listitem');
    const skipper = rows.find((r) => r.textContent?.includes('Skipper'));
    const bosun = rows.find((r) => r.textContent?.includes('Bosun'));

    expect(skipper?.textContent).toContain('HOST');
    expect(bosun?.textContent).toContain('YOU');
    expect(skipper?.textContent).not.toContain('YOU');
  });

  it('shows the join code so members can invite people', () => {
    seat(GUEST, lobbyState());
    render(<LobbyScreen />);
    expect(screen.getByText('BCDFGH')).toBeDefined();
  });

  it('groups members under their position, and says when a group is empty', () => {
    seat(HOST, lobbyState());
    render(<LobbyScreen />);

    expect(screen.getByRole('heading', { name: /Spectating/ })).toBeDefined();
    expect(screen.getByText('Empty')).toBeDefined();
  });
});
