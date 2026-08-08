/**
 * @vitest-environment jsdom
 *
 * The server browser. planning/07 §4 calls it load-bearing (risk R4), so these cover the
 * parts that decide whether a player can find a match at all: the filters actually reach the
 * server, an empty list is legibly empty rather than apparently broken, and there is a way
 * out of an empty list.
 */
import type { LobbySummary } from '@seg/shared';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuth } from '../src/state/auth.js';
import { useLobby } from '../src/state/lobby.js';
import { useNav } from '../src/state/nav.js';
import { BrowseLobbiesScreen } from '../src/ui/BrowseLobbiesScreen.js';

const ACCOUNT = { id: 'a1', username: 'Skipper', createdAt: 0 };

const ALPHA: LobbySummary = {
  id: 'l1',
  name: 'Abyssal Trench',
  playerCount: 2,
  maxPlayers: 6,
  mode: 'objective-capture',
  fleetPoints: 500,
};

const BRAVO: LobbySummary = {
  id: 'l2',
  name: 'Cold Layer',
  playerCount: 6,
  maxPlayers: 6,
  mode: 'deathmatch',
  fleetPoints: 900,
};

const listLobbies = vi.fn(async () => undefined);
const joinById = vi.fn(async () => undefined);

function signedIn(browse: readonly LobbySummary[] | null, playersOnline = 3) {
  useAuth.setState({ status: 'signedIn', account: ACCOUNT, session: null });
  useLobby.setState({ browse, playersOnline, rejection: null, listLobbies, joinById });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  listLobbies.mockClear();
  joinById.mockClear();
  useNav.setState({ screen: 'lobby-browse', authTab: 'signIn' });
  signedIn(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The screen debounces its first request; this lets it through. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

describe('requesting the list', () => {
  it('asks the server once the debounce elapses', async () => {
    render(<BrowseLobbiesScreen />);
    await settle();
    expect(listLobbies).toHaveBeenCalledWith({});
  });

  it('keeps refreshing on its own, so the list does not go stale', async () => {
    render(<BrowseLobbiesScreen />);
    await settle();
    const afterFirst = listLobbies.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });

    expect(listLobbies.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('stops refreshing once the screen goes away', async () => {
    const { unmount } = render(<BrowseLobbiesScreen />);
    await settle();
    unmount();
    const afterUnmount = listLobbies.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(listLobbies.mock.calls.length).toBe(afterUnmount);
  });
});

describe('filters', () => {
  it('sends the name filter, trimmed', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<BrowseLobbiesScreen />);
    await settle();

    await user.type(screen.getByLabelText('Name'), '  cold  ');
    await settle();

    await waitFor(() => expect(listLobbies).toHaveBeenLastCalledWith({ name: 'cold' }));
  });

  it('does not fire a request per keystroke', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<BrowseLobbiesScreen />);
    await settle();
    const before = listLobbies.mock.calls.length;

    // Typed inside one debounce window: this must collapse to a single request.
    await user.type(screen.getByLabelText('Name'), 'cold');
    await settle();

    expect(listLobbies.mock.calls.length - before).toBeLessThanOrEqual(2);
  });

  it('sends the mode filter', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<BrowseLobbiesScreen />);
    await settle();

    await user.selectOptions(screen.getByLabelText('Mode'), 'deathmatch');
    await settle();

    await waitFor(() => expect(listLobbies).toHaveBeenLastCalledWith({ mode: 'deathmatch' }));
  });

  it('sends the open-slots filter', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<BrowseLobbiesScreen />);
    await settle();

    await user.click(screen.getByLabelText(/open slots only/i));
    await settle();

    await waitFor(() => expect(listLobbies).toHaveBeenLastCalledWith({ hasOpenSlots: true }));
  });

  it('omits filters that are not set, rather than sending empty values', async () => {
    render(<BrowseLobbiesScreen />);
    await settle();

    // An empty name must not become `{ name: '' }`, which the server would treat as a
    // filter that matches everything anyway — but the intent should be in the message.
    expect(listLobbies).toHaveBeenCalledWith({});
  });
});

describe('results', () => {
  it('shows each lobby with its mode, budget and occupancy', async () => {
    signedIn([ALPHA]);
    render(<BrowseLobbiesScreen />);
    await settle();

    const row = screen.getByText('Abyssal Trench').closest('li') as HTMLElement;
    expect(within(row).getByText(/Objective Capture/)).toBeDefined();
    expect(within(row).getByText(/500 points/)).toBeDefined();
    expect(within(row).getByText('2 / 6')).toBeDefined();
  });

  it('joins by id, which is all a browser row carries', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    signedIn([ALPHA]);
    render(<BrowseLobbiesScreen />);
    await settle();

    await user.click(screen.getByRole('button', { name: 'JOIN' }));

    expect(joinById).toHaveBeenCalledWith('l1');
  });

  it('offers a full lobby as a spectate rather than hiding the way in', async () => {
    signedIn([BRAVO]);
    render(<BrowseLobbiesScreen />);
    await settle();

    // The server seats an over-capacity joiner as a spectator, so the row stays actionable
    // and the label is what changes.
    expect(screen.getByRole('button', { name: 'SPECTATE' })).toBeDefined();
  });

  it('distinguishes "not asked yet" from "none found"', async () => {
    signedIn(null);
    const { rerender } = render(<BrowseLobbiesScreen />);
    expect(screen.getByText(/looking for lobbies/i)).toBeDefined();

    signedIn([]);
    rerender(<BrowseLobbiesScreen />);
    await settle();

    expect(screen.queryByText(/looking for lobbies/i)).toBeNull();
    expect(screen.getByText(/nobody is hosting/i)).toBeDefined();
  });
});

describe('an empty list', () => {
  it('offers a one-click way to create a lobby', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    signedIn([]);
    render(<BrowseLobbiesScreen />);
    await settle();

    await user.click(screen.getByRole('button', { name: /create a lobby/i }));

    expect(useNav.getState().screen).toBe('lobby-create');
  });

  it('blames the filters when there are filters to blame, and offers to clear them', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    signedIn([]);
    render(<BrowseLobbiesScreen />);
    await settle();

    await user.type(screen.getByLabelText('Name'), 'nothing matches this');
    await settle();

    expect(screen.getByText(/no lobbies match those filters/i)).toBeDefined();

    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    await settle();

    expect(screen.getByText(/nobody is hosting/i)).toBeDefined();
  });

  it('still reports the player count, so empty is legible rather than broken', async () => {
    signedIn([], 0);
    render(<BrowseLobbiesScreen />);
    await settle();

    // planning/07 §4: "0 players online" is honest; no context at all reads as a bug.
    expect(screen.getByText('0 players online')).toBeDefined();
  });

  it('counts one player without pluralising', async () => {
    signedIn([], 1);
    render(<BrowseLobbiesScreen />);
    await settle();
    expect(screen.getByText('1 player online')).toBeDefined();
  });
});

describe('without an account', () => {
  it('explains why, and does not sit spinning', async () => {
    useAuth.setState({ status: 'signedOut', account: null, session: null });
    render(<BrowseLobbiesScreen />);
    await settle();

    // The gateway authenticates at the upgrade and guest accounts are still open (Q17).
    expect(screen.getByText(/guest access is planned/i)).toBeDefined();
    expect(listLobbies).not.toHaveBeenCalled();
  });

  it('offers a way to sign in', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    useAuth.setState({ status: 'signedOut', account: null, session: null });
    render(<BrowseLobbiesScreen />);

    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(useNav.getState().screen).toBe('auth');
  });
});
