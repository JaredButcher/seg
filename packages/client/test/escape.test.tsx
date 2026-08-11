/**
 * @vitest-environment jsdom
 *
 * What Escape means outside a match: back one level, and nowhere else.
 *
 * The interesting cases are the ones where two levels could both answer the same press — a
 * picker open over the editor that also binds the key — and the lobby, which binds nothing on
 * purpose. The in-match menu's own Escape behaviour is covered in esc-menu.test.tsx.
 */
import type { LobbyState } from '@seg/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuth } from '../src/state/auth.js';
import { useFleet } from '../src/state/fleet.js';
import { useLobby } from '../src/state/lobby.js';
import { useNav } from '../src/state/nav.js';
import { CreateLobbyScreen } from '../src/ui/CreateLobbyScreen.js';
import { FleetEditorScreen } from '../src/ui/FleetEditorScreen.js';
import { LobbyScreen } from '../src/ui/LobbyScreen.js';

const ACCOUNT = { id: 'a1', username: 'Admiral', createdAt: 0 };

const LOBBY: LobbyState = {
  id: 'lobby-1',
  code: 'BCDFGH',
  hostAccountId: ACCOUNT.id,
  settings: {
    name: 'Abyssal Trench',
    maxPlayers: 6,
    mode: 'objective-capture',
    fleetPoints: 500,
    visibility: 'public',
    mapType: 'dense',
    mapSize: 'medium',
    debugMode: false,
  },
  members: [
    {
      occupant: { kind: 'human', accountId: ACCOUNT.id },
      username: ACCOUNT.username,
      position: 'team1',
      joinedAt: 0,
      hasFleet: false,
      ready: false,
    },
  ],
  createdAt: 0,
};

/** jsdom does not implement <dialog>; the hull and module pickers rely on showModal/close. */
function stubDialog() {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}

const leave = vi.fn();

beforeEach(() => {
  stubDialog();
  leave.mockClear();
  useAuth.setState({ status: 'signedIn', account: ACCOUNT, session: null });
  useNav.setState({ screen: 'home', authTab: 'signIn' });
  useLobby.setState({
    lobby: null,
    selfFleet: null,
    status: 'open',
    rejection: null,
    exitNotice: null,
    leave,
  });
  useFleet.setState({
    draftName: 'Test Fleet',
    boats: [],
    savedId: null,
    selected: null,
    saved: [{ id: 'f1', name: 'Wolfpack', boatCount: 2, points: 300, updatedAt: 0 }],
    dirty: false,
    busy: false,
    loading: false,
    error: null,
    savedAt: null,
    refreshSaved: vi.fn(async () => undefined),
  });
});

afterEach(cleanup);

describe('on a menu screen', () => {
  it('goes back to the main menu', async () => {
    const user = userEvent.setup();
    useNav.setState({ screen: 'lobby-create' });
    render(<CreateLobbyScreen />);

    await user.keyboard('{Escape}');

    expect(useNav.getState().screen).toBe('home');
  });

  it('goes back from a field, rather than being swallowed by it', async () => {
    const user = userEvent.setup();
    useNav.setState({ screen: 'lobby-create' });
    render(<CreateLobbyScreen />);

    await user.click(screen.getByLabelText('Lobby name'));
    await user.keyboard('{Escape}');

    expect(useNav.getState().screen).toBe('home');
  });
});

describe('in a lobby', () => {
  beforeEach(() => {
    useNav.setState({ screen: 'lobby' });
    useLobby.setState({ lobby: LOBBY });
  });

  /*
   * The one screen that binds nothing. A lobby is a commitment to the other players in it,
   * and a key that quietly walked out of one would be a way to lose a seat by leaning on the
   * keyboard.
   */
  it('does nothing', async () => {
    const user = userEvent.setup();
    render(<LobbyScreen />);

    await user.keyboard('{Escape}');

    expect(useNav.getState().screen).toBe('lobby');
    expect(leave).not.toHaveBeenCalled();
  });

  it('closes the fleet picker without leaving the lobby', async () => {
    const user = userEvent.setup();
    render(<LobbyScreen />);

    await user.click(screen.getByRole('button', { name: 'SELECT FLEET' }));
    expect(screen.getByRole('dialog', { name: 'Choose a fleet' })).toBeDefined();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Choose a fleet' })).toBeNull();
    });
    expect(useNav.getState().screen).toBe('lobby');
  });
});

describe('in the fleet editor', () => {
  beforeEach(() => useNav.setState({ screen: 'fleet-editor' }));

  it('goes wherever the back link goes', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);

    await user.keyboard('{Escape}');

    expect(useNav.getState().screen).toBe('home');
  });

  it('goes back to the lobby when the editor was opened from one', async () => {
    const user = userEvent.setup();
    useLobby.setState({ lobby: LOBBY });
    render(<FleetEditorScreen />);

    await user.keyboard('{Escape}');

    expect(useNav.getState().screen).toBe('lobby');
  });

  it('closes the load dialog and stays in the editor', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);

    await user.click(screen.getByRole('button', { name: 'LOAD' }));
    expect(screen.getByRole('dialog', { name: 'Load a fleet' })).toBeDefined();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Load a fleet' })).toBeNull();
    });
    expect(useNav.getState().screen).toBe('fleet-editor');
  });

  /*
   * The hull picker is a native <dialog>, which would close itself on Escape. If it did that
   * *and* the editor's own binding fired, one press would close the picker and walk out of
   * the editor behind it — which is the whole reason the key goes through one stack.
   */
  it('closes the hull picker without also leaving the editor', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);

    await user.click(screen.getByRole('button', { name: 'ADD BOAT' }));
    expect(await screen.findByRole('dialog')).toBeDefined();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(useNav.getState().screen).toBe('fleet-editor');
  });

  it('leaves the editor on a second press, once the picker is gone', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);

    await user.click(screen.getByRole('button', { name: 'ADD BOAT' }));
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await user.keyboard('{Escape}');

    expect(useNav.getState().screen).toBe('home');
  });
});
