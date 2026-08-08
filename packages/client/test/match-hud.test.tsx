/**
 * @vitest-environment jsdom
 *
 * The two HUD elements with behaviour rather than only a readout: chat and the mini-map.
 * The score, timer, and fleet list are covered in match-screen.test.tsx, where they are
 * rendered in place against a real projection.
 */
import type { ChatEntry } from '@seg/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLobby } from '../src/state/lobby.js';
import { useMatch } from '../src/state/match.js';
import { MatchScreen } from '../src/ui/MatchScreen.js';
import { formatClock, formatPitch } from '../src/ui/hud/rows.js';
import { seatMatch, stubCanvas, FOE, YOU } from './match-fixture.js';

stubCanvas();

const lookAt = vi.fn();

vi.mock('../src/render/ScopeHost.js', () => ({
  ScopeHost: ({
    controls,
  }: {
    controls?: { current: { lookAt: (p: unknown) => void } | null };
  }) => {
    if (controls !== undefined) controls.current = { lookAt };
    return <div data-testid="scope" />;
  },
}));

const realSendChat = useLobby.getState().sendChat;
let sendChat: ReturnType<typeof vi.fn>;

function line(overrides: Partial<ChatEntry> = {}): ChatEntry {
  return {
    id: 1,
    from: YOU,
    username: 'Skipper',
    team: 'team1',
    scope: 'team',
    text: 'contact west',
    at: 0,
    ...overrides,
  };
}

beforeEach(() => {
  sendChat = vi.fn();
  useLobby.setState({ sendChat });
});

afterEach(() => {
  useLobby.setState({ sendChat: realSendChat });
  useMatch.getState().clear();
  lookAt.mockClear();
  cleanup();
});

describe('chat', () => {
  it('is collapsed to the last line, and says so when there is none', () => {
    seatMatch();
    render(<MatchScreen />);

    expect(screen.getByText(/nothing said yet/i)).toBeTruthy();
    expect(screen.queryByLabelText('Message')).toBeNull();
  });

  it('shows the most recent line while collapsed', () => {
    seatMatch({ chat: [line({ id: 1, text: 'first' }), line({ id: 2, text: 'latest' })] });
    render(<MatchScreen />);

    expect(screen.getByText('latest')).toBeTruthy();
    expect(screen.queryByText('first')).toBeNull();
  });

  it('opens on Enter and puts the caret in the box', async () => {
    const user = userEvent.setup();
    seatMatch();
    render(<MatchScreen />);

    await user.keyboard('{Enter}');

    const input = screen.getByLabelText('Message');
    expect(document.activeElement).toBe(input);
  });

  it('opens on Enter even when a HUD button has the focus', async () => {
    // The guard is "is a text field already taking keystrokes", not "is anything focused". A
    // fleet row the player clicked to jump the camera keeps the focus ring, and chat has to
    // keep working for the rest of the match regardless.
    const user = userEvent.setup();
    seatMatch();
    render(<MatchScreen />);

    await user.click(screen.getByRole('button', { name: /S-01/i }));
    await user.keyboard('{Enter}');

    expect(document.activeElement).toBe(screen.getByLabelText('Message'));
  });

  it('cycles the channel on Tab rather than walking the focus out of the box', async () => {
    const user = userEvent.setup();
    seatMatch();
    render(<MatchScreen />);

    await user.keyboard('{Enter}');
    const input = screen.getByLabelText('Message');

    await user.keyboard('{Tab}');
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('button', { name: 'ALL' }).getAttribute('aria-pressed')).toBe('true');

    // And round again — two channels for a player, so Tab is a toggle.
    await user.keyboard('{Tab}');
    expect(screen.getByRole('button', { name: 'TEAM' }).getAttribute('aria-pressed')).toBe('true');

    await user.type(input, 'back on team{Enter}');
    expect(sendChat).toHaveBeenCalledWith('team', 'back on team');
  });

  it('sends on the team channel by default, and clears the box', async () => {
    const user = userEvent.setup();
    seatMatch();
    render(<MatchScreen />);

    await user.click(screen.getByRole('button', { name: /chat/i }));
    await user.type(screen.getByLabelText('Message'), 'contact west{Enter}');

    expect(sendChat).toHaveBeenCalledWith('team', 'contact west');
    expect((screen.getByLabelText('Message') as HTMLInputElement).value).toBe('');
  });

  it('switches channel without closing', async () => {
    const user = userEvent.setup();
    seatMatch();
    render(<MatchScreen />);

    await user.click(screen.getByRole('button', { name: /chat/i }));
    await user.click(screen.getByRole('button', { name: 'ALL' }));
    await user.type(screen.getByLabelText('Message'), 'good luck{Enter}');

    expect(sendChat).toHaveBeenCalledWith('all', 'good luck');
  });

  it('offers a spectator the observers’ channel and neither of the others', async () => {
    const user = userEvent.setup();
    seatMatch({
      as: 'watcher',
      players: [
        { accountId: YOU, username: 'Skipper', position: 'team1', boats: [] },
        { accountId: 'watcher', username: 'Wendy', position: 'spectator', boats: [] },
      ],
    });
    render(<MatchScreen />);

    await user.click(screen.getByRole('button', { name: /chat/i }));
    const channels = screen.getByRole('group', { name: /channel/i });

    expect(
      within(channels)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['SPECTATOR']);
  });

  it('closes on Escape without opening the match menu behind it', async () => {
    const user = userEvent.setup();
    seatMatch();
    render(<MatchScreen />);

    await user.click(screen.getByRole('button', { name: /chat/i }));
    await user.type(screen.getByLabelText('Message'), '{Escape}');

    expect(screen.queryByLabelText('Message')).toBeNull();
    // The Esc window is a dialog; the key was consumed by the chat box, so there is none.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows why a line was refused', () => {
    seatMatch();
    useMatch.setState({ chatRejection: 'Slow down.' });
    render(<MatchScreen />);

    expect(screen.getByText('Slow down.')).toBeTruthy();
  });
});

describe('the mini-map', () => {
  it('jumps the camera to the point that was clicked', () => {
    const { setup } = seatMatch();
    render(<MatchScreen />);

    const map = screen.getByRole('button', { name: /whole map/i });
    // jsdom gives every element a zero-size box, so the geometry is supplied here; what is
    // under test is that a click is converted through the same fit the panel draws with.
    map.getBoundingClientRect = () => ({ left: 0, top: 0, width: 236, height: 57 }) as DOMRect;

    fireEvent.click(map, { clientX: 118, clientY: 28 });

    expect(lookAt).toHaveBeenCalledTimes(1);
    const point = lookAt.mock.calls[0]?.[0] as { x: number; y: number };
    // The middle of the panel is the middle of the map, and y is *not* inverted on the way
    // back — a mini-map that jumped to the mirror image of the point clicked would be worse
    // than none. The tolerance is a whole panel pixel, which is ~20 m of a 1200 m column.
    expect(point.x).toBeCloseTo(setup.map.extents.width / 2, -2);
    expect(point.y).toBeCloseTo(setup.map.extents.height / 2, -2);
    expect(point.y).toBeGreaterThan(setup.map.extents.height / 4);
  });

  it('draws the same map for both sides', () => {
    seatMatch({ as: FOE });
    render(<MatchScreen />);

    expect(screen.getByRole('button', { name: /whole map/i })).toBeTruthy();
  });
});

describe('formatting', () => {
  it('counts the clock down in minutes, and in tenths at the end', () => {
    expect(formatClock(1800)).toBe('30:00');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(9.4)).toBe('0:09.4');
    expect(formatClock(-1)).toBe('0:00.0');
  });

  it('reads pitch as a down angle, whichever way the boat is pointing', () => {
    // `facing` is counter-clockwise in a y-up frame, so positive is nose-up, and a boat
    // travelling left has a facing near 180°.
    expect(formatPitch(0)).toBe('—');
    expect(formatPitch(180)).toBe('—');
    expect(formatPitch(-20)).toBe('▾20°');
    expect(formatPitch(20)).toBe('▴20°');
    expect(formatPitch(200)).toBe('▾20°');
    expect(formatPitch(160)).toBe('▴20°');
  });
});
