/**
 * @vitest-environment jsdom
 *
 * The match screen: it hands the map to the scope host, and the HUD reads the match back.
 * ScopeHost is mocked — the Pixi canvas is a WebGL concern these tests have no business
 * opening, and the render loop is covered in the browser, not in jsdom.
 */
import { generateMap } from '@seg/shared';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useLobby } from '../src/state/lobby.js';
import { useMatch } from '../src/state/match.js';
import { MatchScreen } from '../src/ui/MatchScreen.js';
import { seatMatch, stubCanvas, stubDialog, FOE, YOU } from './match-fixture.js';

stubCanvas();
stubDialog();

const lookAt = vi.fn();
/** Whether the stand-in scope claims a drag is in progress. Off unless a test says otherwise. */
const dragging = vi.fn(() => false);
/** The scope's command callbacks, captured by the stand-in so the tests can fire them. */
const scope = vi.hoisted(() => ({
  onOrder: null as null | ((to: { x: number; y: number }, queue: boolean) => void),
  onSelect: null as null | ((boat: number) => void),
  onCancel: null as null | (() => void),
}));

vi.mock('../src/render/ScopeHost.js', () => ({
  ScopeHost: (props: {
    map: { mapType: string };
    controls?: { current: { lookAt: (p: unknown) => void; dragging: () => boolean } | null };
    onOrder?: (to: { x: number; y: number }, queue: boolean) => void;
    onSelect?: (boat: number) => void;
    onCancel?: () => void;
  }) => {
    scope.onOrder = props.onOrder ?? null;
    scope.onSelect = props.onSelect ?? null;
    scope.onCancel = props.onCancel ?? null;
    if (props.controls !== undefined) props.controls.current = { lookAt, dragging };
    return <div data-testid="scope" data-map-type={props.map.mapType} />;
  },
}));

const seat = seatMatch;

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

/** The real command sender, put back after any test that stands a spy in its place. */
const realSetActiveSonar = useLobby.getState().setActiveSonar;

afterEach(() => {
  useMatch.getState().clear();
  useLobby.setState({ setActiveSonar: realSetActiveSonar });
  lookAt.mockClear();
  dragging.mockClear();
  dragging.mockReturnValue(false);
  scope.onOrder = null;
  scope.onSelect = null;
  scope.onCancel = null;
  vi.restoreAllMocks();
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
    // Each row now also carries a throttle strip, so the depth lives on the row's own button
    // (the camera target) rather than on the strip's.
    const first = view.boats.find((b) => b.id === setup.fleet[0]?.id);
    expect(first).toBeDefined();
    // The row hit targets, not every button in the panel — each row also carries an active
    // sonar switch, whose name is about pinging rather than about depth.
    const depths = within(fleet)
      .getAllByRole('button', { name: /deep/i })
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
      expect(
        within(rows()[1]!)
          .getByRole('button', { name: /centre the scope/i })
          .getAttribute('aria-label'),
      ).toMatch(/Key 2\. Selected\./);
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
     * The key does what clicking the row does, and then some: a player who has just named a
     * boat wants to be looking at it, and having to reach for the mouse to finish the thought
     * is the whole cost the binding was meant to remove.
     */
    it('jumps the camera to the boat it names', async () => {
      const { setup, view } = fleetOf(3);
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('2');

      const second = view.boats.find((boat) => boat.id === setup.fleet[1]?.id);
      expect(second).toBeDefined();
      expect(lookAt).toHaveBeenCalledTimes(1);
      expect(lookAt.mock.calls[0]?.[0]).toEqual(second?.pos);
    });

    /*
     * Except while the pointer has the camera. Selection still lands — the keys must not go
     * dead for as long as the mouse is down — but the look is withheld, because a camera that
     * teleported mid-drag would carry on panning from somewhere the player never pointed.
     */
    it('leaves the camera alone while the scope is being dragged', async () => {
      const { setup } = fleetOf(3);
      const user = userEvent.setup();
      render(<MatchScreen />);
      dragging.mockReturnValue(true);

      await user.keyboard('2');

      expect(useMatch.getState().selected).toBe(setup.fleet[1]?.id);
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

  // ── selecting a boat by pointing at it ─────────────────────────────────────

  /*
   * The two click routes to a selection (planning/08 §5). They are the same command as the
   * number key and are asserted against the same things: the store, the row that wears the
   * mark, and what the *next* click on the water then does — a selection nothing can be
   * ordered against is not a selection.
   */
  describe('selecting a boat by clicking', () => {
    function rows() {
      return within(screen.getByRole('region', { name: /fleet/i })).getAllByRole('listitem');
    }

    it('selects the boat whose fleet row was clicked, and looks at it', async () => {
      const { setup, view } = fleetOf(3);
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.click(within(rows()[1]!).getByRole('button', { name: /centre the scope/i }));

      expect(useMatch.getState().selected).toBe(setup.fleet[1]?.id);
      expect(rows().map((row) => row.getAttribute('data-selected'))).toEqual([null, 'true', null]);

      const second = view.boats.find((snapshot) => snapshot.id === setup.fleet[1]?.id);
      expect(lookAt).toHaveBeenCalledTimes(1);
      expect(lookAt.mock.calls[0]?.[0]).toEqual(second?.pos);
    });

    it('sends a following order to the boat whose row was clicked', async () => {
      const { setup } = fleetOf(3);
      const user = userEvent.setup();
      const order = vi.spyOn(useLobby.getState(), 'orderBoat');
      render(<MatchScreen />);

      await user.click(within(rows()[2]!).getByRole('button', { name: /centre the scope/i }));
      scope.onOrder?.({ x: 700, y: 300 }, false);

      expect(order).toHaveBeenCalledWith(setup.fleet[2]?.id, { x: 700, y: 300 }, false);
    });

    it('moves the selection rather than adding to it', async () => {
      const { setup } = fleetOf(3);
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.click(within(rows()[0]!).getByRole('button', { name: /centre the scope/i }));
      await user.click(within(rows()[2]!).getByRole('button', { name: /centre the scope/i }));

      expect(useMatch.getState().selected).toBe(setup.fleet[2]?.id);
      expect(rows().filter((row) => row.getAttribute('data-selected') !== null)).toHaveLength(1);
    });

    /*
     * A click on a hull in the scope. The hit test itself is the scope's — it is the only thing
     * holding the zoom the tolerance is measured in, and it is covered in `boat-pick.test.ts`;
     * what is asserted here is the half above it, that the boat the scope names becomes the
     * selection and that the camera is *not* dragged onto something already under the cursor.
     */
    it('selects the boat the scope reports a click on, without moving the camera', () => {
      const { setup } = fleetOf(3);
      render(<MatchScreen />);

      act(() => {
        scope.onSelect?.(setup.fleet[2]?.id ?? 0);
      });

      expect(useMatch.getState().selected).toBe(setup.fleet[2]?.id);
      expect(rows().map((row) => row.getAttribute('data-selected'))).toEqual([null, null, 'true']);
      expect(lookAt).not.toHaveBeenCalled();
    });

    it('sends a following order to the boat the scope reported', () => {
      const { setup } = fleetOf(3);
      const order = vi.spyOn(useLobby.getState(), 'orderBoat');
      render(<MatchScreen />);

      act(() => {
        scope.onSelect?.(setup.fleet[1]?.id ?? 0);
      });
      scope.onOrder?.({ x: 250, y: 900 }, true);

      expect(order).toHaveBeenCalledWith(setup.fleet[1]?.id, { x: 250, y: 900 }, true);
    });
  });

  // ── commanding a boat ──────────────────────────────────────────────────────

  describe('commanding a boat', () => {
    /** Fire the scope's click, as if the player pressed and released on the water. */
    function clicked(to: { x: number; y: number }, queue = false) {
      scope.onOrder?.(to, queue);
    }

    it('orders the selected boat to the point that was clicked', async () => {
      const user = userEvent.setup();
      const { setup } = fleetOf(3);
      const order = vi.spyOn(useLobby.getState(), 'orderBoat');
      render(<MatchScreen />);

      await user.keyboard('2');
      clicked({ x: 400, y: 200 });

      expect(order).toHaveBeenCalledWith(setup.fleet[1]?.id, { x: 400, y: 200 }, false);
    });

    it('queues a leg on a shift-click instead of replacing the route', async () => {
      const user = userEvent.setup();
      const { setup } = fleetOf(2);
      const order = vi.spyOn(useLobby.getState(), 'orderBoat');
      render(<MatchScreen />);

      await user.keyboard('1');
      clicked({ x: 500, y: 100 }, true);

      expect(order).toHaveBeenCalledWith(setup.fleet[0]?.id, { x: 500, y: 100 }, true);
    });

    it('does nothing on a click while no boat is selected', async () => {
      const order = vi.spyOn(useLobby.getState(), 'orderBoat');
      render(<MatchScreen />);

      clicked({ x: 400, y: 200 });

      expect(order).not.toHaveBeenCalled();
    });

    it('cancels the selected boat’s orders on a right-click', async () => {
      const user = userEvent.setup();
      const { setup } = fleetOf(3);
      const cancel = vi.spyOn(useLobby.getState(), 'cancelOrders');
      render(<MatchScreen />);

      await user.keyboard('1');
      scope.onCancel?.();

      expect(cancel).toHaveBeenCalledWith(setup.fleet[0]?.id);
    });

    it('sends the throttle notch a row asks for, for that boat only', async () => {
      const user = userEvent.setup();
      const { setup } = seat();
      const setThrottle = vi.spyOn(useLobby.getState(), 'setThrottle');
      render(<MatchScreen />);
      const fleet = screen.getByRole('region', { name: /fleet/i });

      // Both rows wear the same three notches, so the press is aimed at one row.
      const second = within(fleet).getAllByRole('listitem')[1]!;
      await user.click(within(second).getByRole('button', { name: 'FLANK' }));

      expect(setThrottle).toHaveBeenCalledWith(setup.fleet[1]?.id, 'flank');
      expect(setThrottle).not.toHaveBeenCalledWith(setup.fleet[0]?.id, 'flank');
    });

    it('marks the pressed notch on each row', () => {
      seat();
      render(<MatchScreen />);
      const fleet = screen.getByRole('region', { name: /fleet/i });

      const first = within(fleet).getAllByRole('listitem')[0]!;
      expect(within(first).getByRole('button', { name: 'SLOW' }).getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(within(first).getByRole('button', { name: 'FULL' }).getAttribute('aria-pressed')).toBe(
        'false',
      );
    });
  });

  // ── active sonar ────────────────────────────────────────────────────────────

  /*
   * The command is a *request*: nothing about the boat changes locally, and the switch on
   * screen moves only when a view frame comes back saying it did. So what these assert is what
   * went on the wire, which is the whole of this client's side of the contract.
   */
  describe('the active sonar switch', () => {
    function seatWithSpy() {
      const setActiveSonar = vi.fn();
      const seated = seat();
      useLobby.setState({ setActiveSonar });
      return { ...seated, setActiveSonar };
    }

    it('is off on every row of a freshly deployed fleet', () => {
      seat();
      render(<MatchScreen />);

      const fleet = screen.getByRole('region', { name: /fleet/i });
      const switches = within(fleet).getAllByRole('button', { name: /ping/i });
      expect(switches).toHaveLength(2);
      expect(switches.every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(
        true,
      );
    });

    it('asks the server to switch the boat whose row was pressed', async () => {
      const { setup, setActiveSonar } = seatWithSpy();
      const user = userEvent.setup();
      render(<MatchScreen />);

      const fleet = screen.getByRole('region', { name: /fleet/i });
      await user.click(within(fleet).getAllByRole('button', { name: /ping/i })[1]!);

      expect(setActiveSonar).toHaveBeenCalledWith(setup.fleet[1]?.id, true);
    });

    it('answers Q for the selected boat', async () => {
      const { setup, setActiveSonar } = seatWithSpy();
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('2');
      await user.keyboard('q');

      expect(setActiveSonar).toHaveBeenCalledWith(setup.fleet[1]?.id, true);
    });

    /*
     * Nothing, rather than the first boat or the last one selected. A key that acted on a boat
     * the player has not named is a key that switches on a sonar somewhere they are not looking,
     * which in this game is how you get killed by your own HUD.
     */
    it('does nothing on Q with no boat selected', async () => {
      const { setActiveSonar } = seatWithSpy();
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('q');

      expect(setActiveSonar).not.toHaveBeenCalled();
    });

    it('stays out of the way of chat and of the match menu', async () => {
      const { setActiveSonar } = seatWithSpy();
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('1');
      await user.keyboard('{Enter}');
      await user.keyboard('q');
      expect(setActiveSonar).not.toHaveBeenCalled();
      expect((screen.getByLabelText('Message') as HTMLInputElement).value).toBe('q');

      await user.keyboard('{Escape}');
      await user.keyboard('{Escape}');
      await user.keyboard('q');
      expect(setActiveSonar).not.toHaveBeenCalled();
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
