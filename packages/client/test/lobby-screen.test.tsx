/**
 * @vitest-environment jsdom
 *
 * The lobby screen's host/non-host split, and the save/revert draft model.
 *
 * The store is driven directly rather than through a socket: what these cover is which
 * controls a given player gets and what Save actually sends, and a real WebSocket would only
 * add flake. The socket round trip is covered server-side in gateway.test.ts.
 */
import type { LobbyMember, LobbySettings, LobbyState, SelectedFleet } from '@seg/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuth } from '../src/state/auth.js';
import { useFleet } from '../src/state/fleet.js';
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
  mapType: 'dense',
  mapSize: 'medium',
  debugMode: false,
};

function member(
  id: string,
  username: string,
  position: LobbyMember['position'],
  over: Partial<LobbyMember> = {},
): LobbyMember {
  return {
    occupant: { kind: 'human', accountId: id },
    username,
    position,
    joinedAt: 0,
    hasFleet: false,
    ready: false,
    ...over,
  };
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
function seat(account: typeof HOST, lobby: LobbyState, selfFleet: SelectedFleet | null = null) {
  useAuth.setState({ status: 'signedIn', account, session: null });
  useLobby.setState({ lobby, selfFleet, status: 'open', rejection: null, exitNotice: null });
}

const modify = vi.fn();
const kick = vi.fn();
const setPosition = vi.fn();
const leave = vi.fn();
const selectFleet = vi.fn();
const setReady = vi.fn();
const startMatch = vi.fn();

beforeEach(() => {
  modify.mockClear();
  kick.mockClear();
  setPosition.mockClear();
  leave.mockClear();
  selectFleet.mockClear();
  setReady.mockClear();
  startMatch.mockClear();
  useLobby.setState({ modify, kick, setPosition, leave, selectFleet, setReady, startMatch });
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
      mapType: 'dense',
      mapSize: 'medium',
      debugMode: false,
    });
  });

  it('sends map type and size with the draft on Save', async () => {
    const user = userEvent.setup();
    render(<LobbyScreen />);

    await user.click(screen.getByRole('radio', { name: 'Empty' }));
    await user.click(screen.getByRole('radio', { name: 'Large' }));
    await user.click(screen.getByRole('button', { name: 'SAVE' }));

    expect(modify).toHaveBeenCalledWith({
      name: 'Abyssal Trench',
      maxPlayers: 6,
      fleetPoints: 500,
      mode: 'objective-capture',
      visibility: 'public',
      mapType: 'empty',
      mapSize: 'large',
      debugMode: false,
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

  it('adopts a map type and size change from the server when it has nothing unsaved', () => {
    const { rerender } = render(<LobbyScreen />);
    expect((screen.getByRole('radio', { name: 'Dense' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: 'Medium' }) as HTMLInputElement).checked).toBe(true);

    // The host changes the map while the player is in the lobby; the broadcast arrives with
    // nothing unsaved, so the draft follows it.
    useLobby.setState({
      lobby: lobbyState({ settings: { ...DEFAULT_SETTINGS, mapType: 'empty', mapSize: 'large' } }),
    });
    rerender(<LobbyScreen />);

    expect((screen.getByRole('radio', { name: 'Empty' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: 'Large' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: 'Dense' }) as HTMLInputElement).checked).toBe(false);
  });

  it('keeps a half-finished map edit when a settings broadcast arrives', () => {
    const { rerender } = render(<LobbyScreen />);

    // Host drafts a map change but has not saved it.
    fireEvent.click(screen.getByRole('radio', { name: 'Empty' }));
    expect(isDisabled(screen.getByRole('button', { name: 'SAVE' }))).toBe(false);

    // A lobby.state arrives (someone joined) with the still-saved settings. The guard in the
    // reconciliation means the in-progress edit survives rather than being overwritten.
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

    expect((screen.getByRole('radio', { name: 'Empty' }) as HTMLInputElement).checked).toBe(true);
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

  it('shows the map type and size the host chose', () => {
    // A fresh joiner is shown the lobby as configured — map included.
    useLobby.setState({
      lobby: lobbyState({
        settings: { ...DEFAULT_SETTINGS, mapType: 'empty', mapSize: 'large' },
      }),
    });
    render(<LobbyScreen />);

    const empty = screen.getByRole('radio', { name: 'Empty' }) as HTMLInputElement;
    const large = screen.getByRole('radio', { name: 'Large' }) as HTMLInputElement;
    expect(empty.checked).toBe(true);
    expect(large.checked).toBe(true);
    // Read-only for the non-host, exactly like every other setting.
    expect(isDisabled(empty)).toBe(true);
    expect(isDisabled(large)).toBe(true);
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

// ── fleet selection, readiness, and start ───────────────────────────────────────

const MY_FLEET: SelectedFleet = { id: 'f1', name: 'First Wolfpack', boatCount: 4, points: 460 };

/** One roster row, found by the username in it. */
function row(username: string): HTMLElement {
  const found = within(players())
    .getAllByRole('listitem')
    .find((r) => r.textContent?.includes(username));
  if (found === undefined) throw new Error(`no roster row for ${username}`);
  return found;
}

describe('choosing a fleet', () => {
  it('names your own fleet and its point value on your row', () => {
    seat(
      GUEST,
      lobbyState({
        members: [
          member(HOST.id, 'Skipper', 'team1'),
          member(GUEST.id, 'Bosun', 'team2', { hasFleet: true }),
        ],
      }),
      MY_FLEET,
    );
    render(<LobbyScreen />);

    expect(row('Bosun').textContent).toContain('First Wolfpack');
    expect(row('Bosun').textContent).toContain('460 pts');
  });

  it('tells you only that someone else has a fleet, never which', () => {
    seat(
      GUEST,
      lobbyState({
        members: [
          member(HOST.id, 'Skipper', 'team1', { hasFleet: true }),
          member(GUEST.id, 'Bosun', 'team2'),
        ],
      }),
      null,
    );
    render(<LobbyScreen />);

    // The privacy property, asserted from the outside: the roster says a fleet exists and
    // stops there. There is nothing else it *could* say — the name never reaches this client.
    expect(row('Skipper').textContent).toContain('Fleet chosen');
    expect(row('Skipper').textContent).not.toContain('First Wolfpack');
  });

  it('says when a player has picked nothing', () => {
    seat(HOST, lobbyState());
    render(<LobbyScreen />);
    expect(row('Bosun').textContent).toContain('No fleet');
  });

  it('opens the picker against the lobby budget, and refuses what does not fit', async () => {
    const user = userEvent.setup();
    // The picker re-reads the saved list on open; supply it directly rather than a fetch.
    useFleet.setState({
      refreshSaved: vi.fn(async () => undefined),
      loading: false,
      saved: [
        { id: 'f1', name: 'First Wolfpack', boatCount: 4, points: 460, updatedAt: 0 },
        { id: 'f2', name: 'Overweight', boatCount: 6, points: 900, updatedAt: 0 },
      ],
    });
    seat(GUEST, lobbyState(), null);
    render(<LobbyScreen />);

    await user.click(screen.getByRole('button', { name: 'SELECT FLEET' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose a fleet' });

    // 900 points against a 500-point lobby: listed, so the player can see why, but inert.
    expect(isDisabled(within(dialog).getByRole('button', { name: /^Overweight/ }))).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: /^First Wolfpack/ }));
    // Only the id goes up — the client never asserts what a fleet costs.
    expect(selectFleet).toHaveBeenCalledWith('f1');
  });
});

describe('readiness', () => {
  it('cannot be set until a fleet is chosen', () => {
    seat(GUEST, lobbyState(), null);
    render(<LobbyScreen />);
    expect(isDisabled(screen.getByRole('button', { name: 'READY' }))).toBe(true);
  });

  it('is enabled once a fleet is chosen', () => {
    seat(GUEST, lobbyState(), MY_FLEET);
    render(<LobbyScreen />);
    expect(isDisabled(screen.getByRole('button', { name: 'READY' }))).toBe(false);
  });

  it('toggles to NOT READY, and turning it off sends false', async () => {
    const user = userEvent.setup();
    seat(
      GUEST,
      lobbyState({
        members: [
          member(HOST.id, 'Skipper', 'team1'),
          member(GUEST.id, 'Bosun', 'team2', { hasFleet: true, ready: true }),
        ],
      }),
      MY_FLEET,
    );
    render(<LobbyScreen />);

    await user.click(screen.getByRole('button', { name: 'NOT READY' }));
    expect(setReady).toHaveBeenCalledWith(false);
  });

  it('marks who is ready and who is not on the roster', () => {
    seat(
      HOST,
      lobbyState({
        members: [
          member(HOST.id, 'Skipper', 'team1', { hasFleet: true, ready: true }),
          member(GUEST.id, 'Bosun', 'team2', { hasFleet: true }),
        ],
      }),
    );
    render(<LobbyScreen />);

    expect(row('Skipper').textContent).toContain('READY');
    expect(row('Bosun').textContent).toContain('NOT READY');
    expect(within(players()).getByText('1 / 2 ready · 2 / 6')).toBeDefined();
  });

  it('is not offered to a spectator, who fields nothing', () => {
    seat(
      GUEST,
      lobbyState({
        members: [member(HOST.id, 'Skipper', 'team1'), member(GUEST.id, 'Bosun', 'spectator')],
      }),
      MY_FLEET,
    );
    render(<LobbyScreen />);

    expect(isDisabled(screen.getByRole('button', { name: 'READY' }))).toBe(true);
    expect(row('Bosun').textContent).not.toContain('NOT READY');
  });
});

describe('starting the match', () => {
  const ALL_READY = {
    members: [
      member(HOST.id, 'Skipper', 'team1', { hasFleet: true, ready: true }),
      member(GUEST.id, 'Bosun', 'team2', { hasFleet: true, ready: true }),
    ],
  };

  it('is offered to the host alone', () => {
    seat(GUEST, lobbyState(ALL_READY), MY_FLEET);
    render(<LobbyScreen />);
    expect(screen.queryByRole('button', { name: 'START MATCH' })).toBeNull();
  });

  it('stays disabled while anyone is not ready', () => {
    seat(
      HOST,
      lobbyState({
        members: [
          member(HOST.id, 'Skipper', 'team1', { hasFleet: true, ready: true }),
          member(GUEST.id, 'Bosun', 'team2', { hasFleet: true }),
        ],
      }),
      MY_FLEET,
    );
    render(<LobbyScreen />);

    expect(isDisabled(screen.getByRole('button', { name: 'START MATCH' }))).toBe(true);
  });

  it('enables once every player is ready', async () => {
    const user = userEvent.setup();
    seat(HOST, lobbyState(ALL_READY), MY_FLEET);
    render(<LobbyScreen />);

    const start = screen.getByRole('button', { name: 'START MATCH' });
    expect(isDisabled(start)).toBe(false);

    await user.click(start);
    expect(startMatch).toHaveBeenCalled();
  });

  it('ignores spectators, who would otherwise hold the lobby hostage', () => {
    seat(
      HOST,
      lobbyState({
        members: [
          member(HOST.id, 'Skipper', 'team1', { hasFleet: true, ready: true }),
          member(GUEST.id, 'Bosun', 'spectator'),
        ],
      }),
      MY_FLEET,
    );
    render(<LobbyScreen />);

    expect(isDisabled(screen.getByRole('button', { name: 'START MATCH' }))).toBe(false);
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
    // Scoped to the roster: the settings panel's "Map type" choice has an "Empty" option too.
    expect(within(players()).getByText('Empty')).toBeDefined();
  });
});
