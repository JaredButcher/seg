/**
 * @vitest-environment jsdom
 *
 * planning/13 §14 sets no coverage target for client code — it is covered by E2E and
 * manual testing. These tests are therefore deliberately narrow: they cover the form
 * *logic* that would otherwise only be caught by a human clicking around, and nothing
 * about presentation.
 */
import { AUTH_ROUTES } from '@seg/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuth } from '../src/state/auth.js';
import { AuthScreen } from '../src/ui/AuthScreen.js';

const GOOD_PASSWORD = 'correct horse battery staple';

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ACCOUNT = {
  account: { id: 'a1', username: 'Skipper', createdAt: 1_700_000_000_000 },
  session: { expiresAt: 1_800_000_000_000, remembered: true },
};

beforeEach(() => {
  useAuth.setState({ status: 'signedOut', account: null, session: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sign-up form', () => {
  it('places the no-recovery warning above the fields, not as fine print', async () => {
    const user = userEvent.setup();
    render(<AuthScreen />);
    await user.click(screen.getByRole('tab', { name: /create account/i }));

    const warning = screen.getByRole('heading', { name: /no password reset/i });
    const usernameField = screen.getByLabelText('Username');

    // planning/07 §2 requires the warning to precede the form. DOCUMENT_POSITION_FOLLOWING
    // means the username field comes after the warning in document order.
    expect(
      warning.compareDocumentPosition(usernameField) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('states the minimum password length before anything is typed', async () => {
    const user = userEvent.setup();
    render(<AuthScreen />);
    await user.click(screen.getByRole('tab', { name: /create account/i }));

    const requirement = screen.getByText('At least 10 characters');
    expect(requirement).toBeDefined();
    // Visible immediately, not only after a failed submit.
    expect(requirement.closest('li')?.dataset['met']).toBe('false');
  });

  it('ticks the length requirement off live, counting the way the server counts', async () => {
    const user = userEvent.setup();
    render(<AuthScreen />);
    await user.click(screen.getByRole('tab', { name: /create account/i }));

    const password = screen.getByLabelText('Password', { exact: true });
    const item = () => screen.getByText('At least 10 characters').closest('li');

    await user.type(password, 'short');
    expect(item()?.dataset['met']).toBe('false');

    await user.type(password, 'er-now');
    expect(item()?.dataset['met']).toBe('true');
  });

  it('counts emoji as one character each, matching the shared validator', async () => {
    const user = userEvent.setup();
    render(<AuthScreen />);
    await user.click(screen.getByRole('tab', { name: /create account/i }));

    const item = () => screen.getByText('At least 10 characters').closest('li');

    // 9 emoji is 18 UTF-16 units but 9 characters — must NOT count as satisfied.
    await user.type(screen.getByLabelText('Password', { exact: true }), '😀'.repeat(9));
    expect(item()?.dataset['met']).toBe('false');
  });

  it('requires the no-recovery acknowledgement', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetch(() => json(201, ACCOUNT));
    render(<AuthScreen />);

    await user.click(screen.getByRole('tab', { name: /create account/i }));
    expect(screen.getByRole('heading', { name: /no password reset/i })).toBeDefined();

    await user.type(screen.getByLabelText('Username'), 'Skipper');
    await user.type(screen.getByLabelText('Password'), GOOD_PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), GOOD_PASSWORD);
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/confirm you understand/i)).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('submits once every requirement is met', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetch(() => json(201, ACCOUNT));
    render(<AuthScreen />);

    await user.click(screen.getByRole('tab', { name: /create account/i }));
    await user.type(screen.getByLabelText('Username'), 'Skipper');
    await user.type(screen.getByLabelText('Password'), GOOD_PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), GOOD_PASSWORD);
    await user.click(screen.getByLabelText(/cannot be recovered/i));
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(AUTH_ROUTES.signup);
    expect(JSON.parse(String(init?.body))).toEqual({
      username: 'Skipper',
      password: GOOD_PASSWORD,
      rememberMe: true,
    });
    await waitFor(() => expect(useAuth.getState().status).toBe('signedIn'));
  });

  it('catches a mistyped confirmation before it reaches the server', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetch(() => json(201, ACCOUNT));
    render(<AuthScreen />);

    await user.click(screen.getByRole('tab', { name: /create account/i }));
    await user.type(screen.getByLabelText('Username'), 'Skipper');
    await user.type(screen.getByLabelText('Password'), GOOD_PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), 'correct horse battery stapel');
    await user.click(screen.getByLabelText(/cannot be recovered/i));
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/passwords do not match/i)).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('applies the shared validation rules without asking the server', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetch(() => json(201, ACCOUNT));
    render(<AuthScreen />);

    await user.click(screen.getByRole('tab', { name: /create account/i }));
    await user.type(screen.getByLabelText('Username'), 'ab');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.type(screen.getByLabelText('Confirm password'), 'short');
    await user.click(screen.getByLabelText(/cannot be recovered/i));
    await user.click(screen.getByRole('button', { name: /create account/i }));

    // Matched on the full error phrasing: "at least N characters" alone also appears in
    // the persistent hint text under each field.
    expect(await screen.findByText(/username must be at least 3 characters/i)).toBeDefined();
    expect(screen.getByText(/password must be at least 10 characters/i)).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('places a server field error on the field it belongs to', async () => {
    const user = userEvent.setup();
    mockFetch(() =>
      json(409, {
        error: {
          code: 'username_taken',
          message: 'That username is already taken.',
          field: 'username',
        },
      }),
    );
    render(<AuthScreen />);

    await user.click(screen.getByRole('tab', { name: /create account/i }));
    await user.type(screen.getByLabelText('Username'), 'Skipper');
    await user.type(screen.getByLabelText('Password'), GOOD_PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), GOOD_PASSWORD);
    await user.click(screen.getByLabelText(/cannot be recovered/i));
    await user.click(screen.getByRole('button', { name: /create account/i }));

    const error = await screen.findByText(/already taken/i);
    expect(error).toBeDefined();
    expect(screen.getByLabelText('Username').getAttribute('aria-invalid')).toBe('true');
  });
});

describe('sign-in form', () => {
  it('sends credentials and the remember-me preference', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetch(() => json(200, ACCOUNT));
    render(<AuthScreen />);

    await user.type(screen.getByLabelText('Username'), 'Skipper');
    await user.type(screen.getByLabelText('Password'), GOOD_PASSWORD);
    await user.click(screen.getByLabelText(/keep me signed in/i)); // default on -> off
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(AUTH_ROUTES.login);
    expect(JSON.parse(String(init?.body)).rememberMe).toBe(false);
  });

  it('shows a form-level error for bad credentials, attached to neither field', async () => {
    const user = userEvent.setup();
    mockFetch(() =>
      json(401, {
        error: { code: 'invalid_credentials', message: 'Incorrect username or password.' },
      }),
    );
    render(<AuthScreen />);

    await user.type(screen.getByLabelText('Username'), 'Skipper');
    await user.type(screen.getByLabelText('Password'), 'wrong password entirely');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/incorrect username or password/i)).toBeDefined();
    expect(screen.getByLabelText('Username').getAttribute('aria-invalid')).toBeNull();
  });

  it('explains how long a rate limit lasts', async () => {
    const user = userEvent.setup();
    mockFetch(() =>
      json(429, {
        error: {
          code: 'rate_limited',
          message: 'Too many attempts. Try again later.',
          retryAfterSeconds: 900,
        },
      }),
    );
    render(<AuthScreen />);

    await user.type(screen.getByLabelText('Username'), 'Skipper');
    await user.type(screen.getByLabelText('Password'), 'wrong password entirely');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/15 minutes/i)).toBeDefined();
  });

  it('reports an unreachable server rather than failing silently', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    render(<AuthScreen />);

    await user.type(screen.getByLabelText('Username'), 'Skipper');
    await user.type(screen.getByLabelText('Password'), GOOD_PASSWORD);
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/could not reach the server/i)).toBeDefined();
  });

  it('does not disclose credential rules on sign-in', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetch(() => json(200, ACCOUNT));
    render(<AuthScreen />);

    // A too-short password must still be submitted: refusing locally would tell an
    // attacker the minimum length without them ever creating an account.
    await user.type(screen.getByLabelText('Username'), 'ab');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
  });
});
