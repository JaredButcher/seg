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
import { seatMatch, stubCanvas, stubDialog, FOE, YOU } from './match-fixture.js';

stubCanvas();
stubDialog();

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

  // ── selection ───────────────────────────────────────────────────────────────

  describe('selecting a boat with the number keys', () => {
    /** A fleet of `count` boats owned by one player, so the numbering can be read off it. */
    function fleetOf(count: number) {
      return seat({
        players: [
          {
            accountId: YOU,
            username: 'Skipper',
            position: 'team1',
            boats: Array.from({ length: count }, (_, i) => ({
              name: `S-${String(i + 1).padStart(2, '0')}`,
              hull: 'light' as const,
              modules: [],
            })),
          },
        ],
      });
    }

    function rows() {
      return within(screen.getByRole('region', { name: /fleet/i })).getAllByRole('listitem');
    }

    it('wears its key on the row, counting from one', () => {
      fleetOf(3);
      render(<MatchScreen />);

      expect(rows().map((row) => within(row).getByText(/^[0-9]$/).textContent)).toEqual([
        '1',
        '2',
        '3',
      ]);
    });

    it('gives the tenth boat 0, where the key actually is', async () => {
      const { setup } = fleetOf(10);
      const user = userEvent.setup();
      render(<MatchScreen />);

      expect(within(rows()[9]!).getByText('0')).toBeTruthy();

      await user.keyboard('0');
      expect(useMatch.getState().selected).toBe(setup.fleet[9]?.id);
    });

    it('selects the boat the key names, and marks the row', async () => {
      const { setup } = fleetOf(3);
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('2');

      expect(useMatch.getState().selected).toBe(setup.fleet[1]?.id);
      expect(rows().map((row) => row.getAttribute('data-selected'))).toEqual([null, 'true', null]);
      expect(within(rows()[1]!).getByRole('button').getAttribute('aria-label')).toMatch(
        /Key 2\. Selected\./,
      );
    });

    it('moves the selection rather than adding to it', async () => {
      const { setup } = fleetOf(3);
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('3');
      await user.keyboard('1');

      expect(useMatch.getState().selected).toBe(setup.fleet[0]?.id);
      expect(rows().filter((row) => row.getAttribute('data-selected') !== null)).toHaveLength(1);
    });

    /*
     * Selection and the camera are separate: pressing a number says which boat the next order
     * goes to, and yanking the scope across the map every time would make the keys unusable
     * for anything but sightseeing.
     */
    it('does not move the camera', async () => {
      fleetOf(3);
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('2');

      expect(lookAt).not.toHaveBeenCalled();
    });

    it('ignores a key with no boat behind it', async () => {
      fleetOf(2);
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('5');
      await user.keyboard('0');

      expect(useMatch.getState().selected).toBeNull();
    });

    it('stays out of the way while a message is being typed', async () => {
      fleetOf(3);
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('{Enter}');
      await user.keyboard('2');

      expect(useMatch.getState().selected).toBeNull();
      expect((screen.getByLabelText('Message') as HTMLInputElement).value).toBe('2');
    });

    it('stays out of the way while the match menu is up', async () => {
      fleetOf(3);
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('{Escape}');
      expect(screen.getByRole('heading', { name: /match menu/i })).toBeTruthy();
      await user.keyboard('2');

      expect(useMatch.getState().selected).toBeNull();
    });

    it('leaves the browser its own modified digits', async () => {
      fleetOf(3);
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('{Control>}2{/Control}');

      expect(useMatch.getState().selected).toBeNull();
    });
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
