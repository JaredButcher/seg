/**
 * @vitest-environment jsdom
 *
 * planning/13 §14 sets no coverage target for client code. These tests are therefore
 * narrow on purpose: they cover which destinations are reachable from which auth state,
 * and the join-code form's behaviour. Nothing about presentation.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App.js';
import { useAuth } from '../src/state/auth.js';
import { useLobby } from '../src/state/lobby.js';
import { useNav } from '../src/state/nav.js';

const ACCOUNT = { id: 'a1', username: 'Skipper', createdAt: 1_700_000_000_000 };
const SESSION = { expiresAt: 1_800_000_000_000, remembered: true };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * App calls `restore()` on mount, so the store state a test sets up only survives if
 * `GET /me` agrees with it. Both helpers set the store *and* the answer restore will get.
 */
function signedIn() {
  useAuth.setState({ status: 'signedIn', account: ACCOUNT, session: SESSION });
  return stubFetch(() => json(200, { account: ACCOUNT, session: SESSION }));
}

function signedOut() {
  useAuth.setState({ status: 'signedOut', account: null, session: null });
  return stubFetch(() => json(401, { error: { code: 'unauthenticated', message: 'no' } }));
}

function stubFetch(handler: () => Response) {
  const spy = vi.fn(async () => handler());
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  useNav.setState({ screen: 'home', authTab: 'signIn' });
  signedOut();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the home page, signed out', () => {
  it('offers sign in and account creation', () => {
    render(<App />);

    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^create account$/i })).toBeDefined();
  });

  it('opens the auth screen on the tab the pressed button names', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /^create account$/i }));

    expect(screen.getByRole('tab', { name: /create account/i }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('lets a signed-out player browse lobbies without an account', async () => {
    const user = userEvent.setup();
    render(<App />);

    // planning/12 Q17 / risk R4: gating the server browser behind signup is a funnel loss.
    await user.click(screen.getByRole('button', { name: /browse open lobbies/i }));

    expect(screen.getByRole('heading', { name: /open lobbies/i })).toBeDefined();
  });

  it('sends a signed-out player back to the menu if a gated screen is somehow open', () => {
    useNav.setState({ screen: 'fleet-editor', authTab: 'signIn' });
    render(<App />);

    expect(screen.queryByRole('heading', { name: /fleet editor/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeDefined();
  });

  it('returns to the menu from the auth screen', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /^sign in$/i }));
    await user.click(screen.getByRole('button', { name: /back to the main menu/i }));

    expect(screen.getByRole('button', { name: /^create account$/i })).toBeDefined();
  });
});

describe('the home page, signed in', () => {
  beforeEach(signedIn);

  it('shows the account and both sign-out actions', () => {
    render(<App />);

    expect(screen.getByText('Skipper')).toBeDefined();
    expect(screen.getByRole('button', { name: /^sign out$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /sign out everywhere/i })).toBeDefined();
  });

  it.each([
    [/create lobby/i, /create a lobby/i],
    [/join with code/i, /join a lobby/i],
    [/browse lobbies/i, /open lobbies/i],
    [/fleet editor/i, /fleet editor/i],
  ])('reaches %s', async (menuLabel, screenHeading) => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: menuLabel }));

    expect(screen.getByRole('heading', { name: screenHeading })).toBeDefined();
  });

  it('returns to the menu from a destination', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /fleet editor/i }));
    await user.click(screen.getByRole('button', { name: /main menu/i }));

    expect(screen.getByRole('button', { name: /create lobby/i })).toBeDefined();
  });

  it('lands on the menu, not the auth screen, once a sign-in succeeds', () => {
    // The player was on the auth screen when the request came back.
    useNav.setState({ screen: 'auth', authTab: 'signIn' });
    render(<App />);

    expect(screen.getByRole('button', { name: /create lobby/i })).toBeDefined();
    expect(screen.queryByRole('tab', { name: /sign in/i })).toBeNull();
  });
});

describe('the join-code form', () => {
  const joinByCode = vi.fn(async () => undefined);

  beforeEach(() => {
    signedIn();
    useNav.setState({ screen: 'lobby-join', authTab: 'signIn' });
    // The socket itself is covered server-side in gateway.test.ts; what matters here is
    // what the form decides to send, and in what shape.
    joinByCode.mockClear();
    useLobby.setState({ joinByCode, rejection: null });
  });

  it('sends a code typed in lowercase with separators, normalized', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/join code/i), 'bcd-fgh');
    await user.click(screen.getByRole('button', { name: /join lobby/i }));

    expect(joinByCode).toHaveBeenCalledWith('BCDFGH');
  });

  it('rejects a short code without contacting the server', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/join code/i), 'BCDFG');
    await user.click(screen.getByRole('button', { name: /join lobby/i }));

    expect(await screen.findByText(/a join code is 6 characters/i)).toBeDefined();
    expect(joinByCode).not.toHaveBeenCalled();
  });

  it('explains why a code containing a vowel is wrong', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/join code/i), 'BCDFGA');
    await user.click(screen.getByRole('button', { name: /join lobby/i }));

    expect(await screen.findByText(/never contain vowels/i)).toBeDefined();
  });

  it('clears a stale error as soon as the code is edited', async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByLabelText(/join code/i);
    await user.type(input, 'BCDFG');
    await user.click(screen.getByRole('button', { name: /join lobby/i }));
    expect(await screen.findByText(/a join code is 6 characters/i)).toBeDefined();

    await user.type(input, 'H');
    expect(screen.queryByText(/^A join code is 6 characters\.$/)).toBeNull();
  });
});
