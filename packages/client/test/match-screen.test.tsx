/**
 * @vitest-environment jsdom
 *
 * The match screen: it hands the map to the scope host, and the HUD reads the match back.
 * ScopeHost is mocked — the Pixi canvas is a WebGL concern these tests have no business
 * opening, and the render loop is covered in the browser, not in jsdom.
 */
import { generateMap } from '@seg/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMatch } from '../src/state/match.js';
import { MatchScreen } from '../src/ui/MatchScreen.js';
import { seatMatch, stubCanvas, FOE } from './match-fixture.js';

stubCanvas();

const lookAt = vi.fn();

vi.mock('../src/render/ScopeHost.js', () => ({
  ScopeHost: ({
    map,
    controls,
  }: {
    map: { mapType: string };
    controls?: { current: { lookAt: (p: unknown) => void } | null };
  }) => {
    if (controls !== undefined) controls.current = { lookAt };
    return <div data-testid="scope" data-map-type={map.mapType} />;
  },
}));

const seat = seatMatch;

afterEach(() => {
  useMatch.getState().clear();
  lookAt.mockClear();
  cleanup();
});

describe('MatchScreen', () => {
  it('renders a splash while the start event has arrived but the payload has not', () => {
    useMatch.setState({ matchId: 'm1', setups: {}, views: {} });

    render(<MatchScreen />);

    expect(screen.getByText(/loading match/i)).toBeTruthy();
    expect(screen.queryByTestId('scope')).toBeNull();
  });

  it('mounts the scope with the map once the payload lands', () => {
    seat({ map: generateMap('empty', { seed: 42, mapSize: 'large' }) });

    render(<MatchScreen />);

    expect(screen.getByTestId('scope').getAttribute('data-map-type')).toBe('empty');
  });

  it('names the mode and the map in the HUD', () => {
    seat({ mode: 'objective-capture' });

    render(<MatchScreen />);

    // Shared describe helpers, so the labels can never drift from the wire vocabulary.
    expect(screen.getByText(/objective capture/i)).toBeTruthy();
    expect(screen.getByText(/empty/i)).toBeTruthy();
    expect(screen.getByText(/medium/i)).toBeTruthy();
  });

  // ── the fleet list ──────────────────────────────────────────────────────────

  it('lists the boats this player commands, and nobody else’s', () => {
    seat();

    render(<MatchScreen />);
    const fleet = screen.getByRole('region', { name: /fleet/i });

    // Two of their own. Their teammate's boat is on the scope, not in the command list, and
    // the enemy's is not in the payload at all.
    const rows = within(fleet).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(fleet).getByText('S-01')).toBeTruthy();
    expect(within(fleet).getByText('S-02')).toBeTruthy();
    expect(within(fleet).getAllByText(/holding/i)).toHaveLength(2);
  });

  it('reads a boat’s depth from its position, counting down from the surface', () => {
    const { setup, view } = seat();

    render(<MatchScreen />);
    const fleet = screen.getByRole('region', { name: /fleet/i });

    // Deployment spreads the fleet down the water column and never at the surface, so every
    // row is a real depth. If the depth conversion were inverted these would read as ~1200.
    const first = view.boats.find((b) => b.id === setup.fleet[0]?.id);
    expect(first).toBeDefined();
    const depths = within(fleet)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? '');
    expect(depths.every((label) => /\d+m deep/.test(label))).toBe(true);
    expect(depths.some((label) => /\b0m deep/.test(label))).toBe(false);
  });

  it('jumps the camera to a boat when its row is pressed', async () => {
    const user = userEvent.setup();
    seat();

    render(<MatchScreen />);
    const fleet = screen.getByRole('region', { name: /fleet/i });
    await user.click(within(fleet).getAllByRole('button')[0]!);

    expect(lookAt).toHaveBeenCalledTimes(1);
    expect(lookAt.mock.calls[0]?.[0]).toMatchObject({ x: expect.any(Number) as number });
  });

  // ── the score ───────────────────────────────────────────────────────────────

  it('shows both teams, the player’s own first, with a target in objective capture', () => {
    seat({ mode: 'objective-capture' });

    render(<MatchScreen />);
    const score = screen.getByRole('group', { name: /score/i });

    expect(within(score).getByText(/team 1 · you/i)).toBeTruthy();
    expect(within(score).getByText(/^team 2$/i)).toBeTruthy();
    expect(screen.getByText(/first to 1000/i)).toBeTruthy();
  });

  it('scores a deathmatch on surviving fleet points instead', () => {
    const { view } = seat({ mode: 'deathmatch' });

    render(<MatchScreen />);
    const score = screen.getByRole('group', { name: /score/i });

    expect(screen.queryByText(/first to/i)).toBeNull();
    const mine = view.teams.find((team) => team.team === 'team1');
    expect(mine?.survivingPoints).toBeGreaterThan(0);
    expect(within(score).getByText(String(Math.round(mine?.survivingPoints ?? 0)))).toBeTruthy();
  });

  it('reads the same match from the other side of it', () => {
    seat({ as: FOE });

    render(<MatchScreen />);
    const fleet = screen.getByRole('region', { name: /fleet/i });

    // Team 2 brought two boats and sees its own, in its own order.
    expect(within(fleet).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('group', { name: /score/i }).textContent).toMatch(/team 2 · you/i);
  });

  // ── the timer ───────────────────────────────────────────────────────────────

  it('shows the server’s clock, which does not run until the simulation does', () => {
    seat();

    render(<MatchScreen />);

    expect(screen.getByRole('timer').textContent).toContain('30:00');
  });
});
