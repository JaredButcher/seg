/**
 * @vitest-environment jsdom
 *
 * The match screen: it hands the map to the scope host, and the HUD reads the match back.
 * ScopeHost is mocked — the Pixi canvas is a WebGL concern these tests have no business
 * opening, and the render loop is covered in the browser, not in jsdom.
 */
import { DEFAULT_SCORE_TARGET, generateMap, getHull, KNOTS_TO_MPS } from '@seg/shared';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useLobby } from '../src/state/lobby.js';
import { activeView, useMatch } from '../src/state/match.js';
import { MatchScreen } from '../src/ui/MatchScreen.js';
import { formatSpeed } from '../src/ui/hud/rows.js';
import { seatMatch, stubCanvas, stubDialog, FOE, YOU } from './match-fixture.js';

stubCanvas();
stubDialog();

const lookAt = vi.fn();
/** Whether the stand-in scope claims a drag is in progress. Off unless a test says otherwise. */
const dragging = vi.fn(() => false);
/** One route as the scope is handed it. Structural, so the stand-in owes the real module nothing. */
interface Route {
  readonly boatId: number;
  readonly waypoints: readonly { readonly x: number; readonly y: number }[];
  readonly selected: boolean;
  readonly mine: boolean;
}

/** The scope's command callbacks, captured by the stand-in so the tests can fire them. */
const scope = vi.hoisted(() => ({
  onOrder: null as null | ((to: { x: number; y: number }, queue: boolean) => void),
  onSelect: null as null | ((boat: number) => void),
  onCancel: null as null | (() => void),
  /*
   * The fleet getters. Read rather than fired: the real scope polls these from its own ticker
   * (planning/08 §1), so what a test can check is what the poll would have returned.
   */
  routes: null as null | (() => readonly Route[]),
}));

vi.mock('../src/render/ScopeHost.js', () => ({
  ScopeHost: (props: {
    map: { mapType: string };
    controls?: { current: { lookAt: (p: unknown) => void; dragging: () => boolean } | null };
    fleet?: { routes: () => readonly Route[] };
    onOrder?: (to: { x: number; y: number }, queue: boolean) => void;
    onSelect?: (boat: number) => void;
    onCancel?: () => void;
  }) => {
    scope.onOrder = props.onOrder ?? null;
    scope.onSelect = props.onSelect ?? null;
    scope.onCancel = props.onCancel ?? null;
    scope.routes = props.fleet?.routes ?? null;
    /*
     * The handle's lifecycle, not just its contents: the real scope builds one when it builds a
     * Pixi app and drops it when it tears one down, so a fresh mount means a fresh handle. The
     * screen's opening command is keyed on exactly that, and a stand-in that published one
     * handle for the life of the module would test a lifecycle the app does not have.
     */
    const held = props.controls;
    useEffect(() => {
      if (held === undefined) return;
      held.current = { lookAt, dragging };
      return () => {
        held.current = null;
      };
    }, [held]);
    return <div data-testid="scope" data-map-type={props.map.mapType} />;
  },
}));

const seat = seatMatch;

/**
 * Mount the screen and forget the opening frame.
 *
 * A match now frames itself on the player's first boat, so `lookAt` has already been called
 * once by the time any test touches the HUD. The tests below are about the jumps the *player*
 * asks for; the opening one has its own test.
 */
function mount() {
  const result = render(<MatchScreen />);
  lookAt.mockClear();
  return result;
}

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
  scope.routes = null;
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

  // ── the opening command ─────────────────────────────────────────────────────

  /*
   * Where a match starts, as far as the player is concerned: boat one selected and the scope
   * looking at it, exactly as if they had pressed `1`. The scope's own default is the middle of
   * the map (`render/camera.ts`), which is the best it can do with no fleet to follow and the
   * wrong picture the moment there is one.
   */
  describe('the opening command', () => {
    it('presses 1 for the player: first boat selected, camera on it', () => {
      const { setup, view } = fleetOf(3);

      render(<MatchScreen />);

      const first = view.boats.find((boat) => boat.id === setup.fleet[0]?.id);
      expect(first).toBeDefined();
      expect(useMatch.getState().selected).toBe(setup.fleet[0]?.id);
      expect(lookAt).toHaveBeenCalledTimes(1);
      expect(lookAt.mock.calls[0]?.[0]).toEqual(first?.pos);
    });

    /*
     * The regression that made the first attempt at this useless in the app while passing in
     * the tests. React mounts, unmounts, and remounts every screen under StrictMode, and the
     * scope builds a *new* Pixi app — with the camera back at the middle of the map — on the
     * second mount. A one-shot keyed on the match id fires on the first, discarded one and is
     * spent by the time the surviving canvas exists.
     */
    it('commands the scope that survived a remount, not the one thrown away', () => {
      const { setup, view } = fleetOf(3);

      render(
        <StrictMode>
          <MatchScreen />
        </StrictMode>,
      );

      const first = view.boats.find((boat) => boat.id === setup.fleet[0]?.id);
      // Once per mounted scope, and the last call is the one the live canvas received.
      expect(lookAt).toHaveBeenCalledTimes(2);
      expect(lookAt.mock.calls.at(-1)?.[0]).toEqual(first?.pos);
      expect(useMatch.getState().selected).toBe(setup.fleet[0]?.id);
    });

    /*
     * `match.started` can navigate here before `match.state` does, and the fleet's positions
     * come with the frame — so the press waits for one rather than settling for the centre.
     */
    it('waits for the first frame, then frames it', () => {
      const { setup, view } = fleetOf(2);
      const { matchId } = setup;
      useMatch.setState({ views: {} });

      render(<MatchScreen />);
      expect(lookAt).not.toHaveBeenCalled();

      act(() => {
        useMatch.setState({ views: { [matchId]: view } });
      });

      const first = view.boats.find((boat) => boat.id === setup.fleet[0]?.id);
      expect(useMatch.getState().selected).toBe(setup.fleet[0]?.id);
      expect(lookAt).toHaveBeenCalledTimes(1);
      expect(lookAt.mock.calls[0]?.[0]).toEqual(first?.pos);
    });

    /*
     * Once, not every frame. Frames arrive at 10 Hz and the boat moves in all of them; a screen
     * that re-framed on each would be a camera the player cannot pan away from.
     */
    it('does not chase the boat on later frames', () => {
      const { setup, view } = fleetOf(2);
      render(<MatchScreen />);
      lookAt.mockClear();

      act(() => {
        useMatch.setState({
          views: {
            [setup.matchId]: {
              ...view,
              boats: view.boats.map((boat) => ({
                ...boat,
                pos: { x: boat.pos.x + 100, y: boat.pos.y },
              })),
            },
          },
          revision: 2,
        });
      });

      expect(lookAt).not.toHaveBeenCalled();
    });

    /*
     * A spectator has no fleet to open on, so they keep the scope's own view of the whole map —
     * which is the picture their screen is for.
     */
    it('leaves a spectator where the scope opened', () => {
      seat({ as: 'watcher' });

      render(<MatchScreen />);

      expect(lookAt).not.toHaveBeenCalled();
      expect(useMatch.getState().selected).toBeNull();
    });
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
    // row is a real depth. If the depth conversion were inverted these would read as ~MAP_DEPTH.
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

    mount();
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
      mount();

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
      mount();
      dragging.mockReturnValue(true);

      await user.keyboard('2');

      expect(useMatch.getState().selected).toBe(setup.fleet[1]?.id);
      expect(lookAt).not.toHaveBeenCalled();
    });

    /*
     * The four tests below assert a key *not* landing, and the match opens with boat one
     * selected — so what each expects is the opening selection, untouched. Null would mean the
     * opening command had gone missing, which is a different bug and has its own tests.
     */
    it('ignores a key with no boat behind it', async () => {
      const { setup } = fleetOf(2);
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('5');
      await user.keyboard('0');

      expect(useMatch.getState().selected).toBe(setup.fleet[0]?.id);
    });

    it('stays out of the way while a message is being typed', async () => {
      const { setup } = fleetOf(3);
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('{Enter}');
      await user.keyboard('2');

      expect(useMatch.getState().selected).toBe(setup.fleet[0]?.id);
      expect((screen.getByLabelText('Message') as HTMLInputElement).value).toBe('2');
    });

    it('stays out of the way while the match menu is up', async () => {
      const { setup } = fleetOf(3);
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('{Escape}');
      expect(screen.getByRole('heading', { name: /match menu/i })).toBeTruthy();
      await user.keyboard('2');

      expect(useMatch.getState().selected).toBe(setup.fleet[0]?.id);
    });

    it('leaves the browser its own modified digits', async () => {
      const { setup } = fleetOf(3);
      const user = userEvent.setup();
      render(<MatchScreen />);

      await user.keyboard('{Control>}2{/Control}');

      expect(useMatch.getState().selected).toBe(setup.fleet[0]?.id);
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
      mount();

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
      mount();

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

      // Both rows wear the same three notches, so the press is aimed at one row. Matched on the
      // notch's name alone: each button's accessible name goes on to carry the speed that notch
      // is worth on that hull, which is a different number on a Light and a Heavy.
      const second = within(fleet).getAllByRole('listitem')[1]!;
      await user.click(within(second).getByRole('button', { name: /^FLANK\b/ }));

      expect(setThrottle).toHaveBeenCalledWith(setup.fleet[1]?.id, 'flank');
      expect(setThrottle).not.toHaveBeenCalledWith(setup.fleet[0]?.id, 'flank');
    });

    it('marks the pressed notch on each row', () => {
      seat();
      render(<MatchScreen />);
      const fleet = screen.getByRole('region', { name: /fleet/i });

      const first = within(fleet).getAllByRole('listitem')[0]!;
      expect(
        within(first)
          .getByRole('button', { name: /^SLOW\b/ })
          .getAttribute('aria-pressed'),
      ).toBe('true');
      expect(
        within(first)
          .getByRole('button', { name: /^FULL\b/ })
          .getAttribute('aria-pressed'),
      ).toBe('false');
    });

    /*
     * The notches are absolute speeds and each hull answers them differently (`match/world.ts`),
     * so the number on a button is a property of the boat rather than of the notch. The fixture's
     * two boats are a Light and a Heavy, which is exactly the case that would pass if the panel
     * read the speeds off the wrong row's stats.
     */
    it('writes the speed each notch is worth on that hull onto its button', () => {
      seat();
      render(<MatchScreen />);
      const fleet = screen.getByRole('region', { name: /fleet/i });
      const [light, heavy] = within(fleet).getAllByRole('listitem');

      // Slow is five knots for everyone; flank is whatever the hull has.
      expect(
        within(light!)
          .getByRole('button', { name: /^SLOW\b/ })
          .getAttribute('aria-label'),
      ).toBe('SLOW, 2.6 m/s');
      expect(
        within(light!)
          .getByRole('button', { name: /^FLANK\b/ })
          .getAttribute('aria-label'),
      ).toBe(`FLANK, ${formatSpeed(getHull('light').stats.maxSpeed)}`);
      expect(
        within(heavy!)
          .getByRole('button', { name: /^FLANK\b/ })
          .getAttribute('aria-label'),
      ).toBe(`FLANK, ${formatSpeed(getHull('heavy').stats.maxSpeed)}`);

      // Full is a knot under the boat's own cavitation line, which is the pair of numbers the
      // whole control exists to distinguish.
      expect(
        within(heavy!)
          .getByRole('button', { name: /^FULL\b/ })
          .getAttribute('aria-label'),
      ).toBe(`FULL, ${formatSpeed(getHull('heavy').stats.cavitationSpeed - KNOTS_TO_MPS)}`);
    });

    it('reads the speed the boat is actually making onto its row', () => {
      const { setup, view } = seat();
      act(() => {
        useMatch.setState({
          views: {
            [setup.matchId]: {
              ...view,
              boats: view.boats.map((boat) =>
                boat.id === setup.fleet[0]?.id ? { ...boat, speed: 6.25 } : boat,
              ),
            },
          },
          revision: 2,
        });
      });
      render(<MatchScreen />);
      const fleet = screen.getByRole('region', { name: /fleet/i });

      // On the row's own hit target, beside the depth — the speed is a readout, not a command.
      const first = within(fleet).getAllByRole('listitem')[0]!;
      expect(within(first).getByText('6.3 m/s')).toBeTruthy();
      expect(
        within(first).getByRole('button', { name: /deep/i }).getAttribute('aria-label'),
      ).toContain('6.3 m/s');
    });

    /*
     * The keys are the same command as the buttons, aimed at the selection instead of at a row.
     * A notch is a request like everything else here — nothing moves locally, so what these
     * assert is what went on the wire.
     */
    describe('R and F', () => {
      it('steps the selected boat up a notch on R', async () => {
        const user = userEvent.setup();
        const { setup } = fleetOf(2);
        const setThrottle = vi.spyOn(useLobby.getState(), 'setThrottle');
        render(<MatchScreen />);

        await user.keyboard('2');
        await user.keyboard('r');

        // Boats deploy at slow, so one step up is full — and it lands on the *selected* boat.
        expect(setThrottle).toHaveBeenCalledWith(setup.fleet[1]?.id, 'full');
      });

      it('steps back down on F, from the notch the last frame reported', async () => {
        const user = userEvent.setup();
        const { setup, view } = fleetOf(2);
        const setThrottle = vi.spyOn(useLobby.getState(), 'setThrottle');
        render(<MatchScreen />);

        await user.keyboard('1');
        // The step is measured against the *boat's* notch rather than anything the panel
        // remembers, so the boat is put at flank by a frame the way the server would.
        act(() => {
          useMatch.setState({
            views: {
              [setup.matchId]: {
                ...view,
                boats: view.boats.map((boat) =>
                  boat.id === setup.fleet[0]?.id ? { ...boat, throttle: 'flank' as const } : boat,
                ),
              },
            },
            revision: 2,
          });
        });
        await user.keyboard('f');

        expect(setThrottle).toHaveBeenCalledWith(setup.fleet[0]?.id, 'full');
      });

      it('says nothing at the ends of the ladder', async () => {
        const user = userEvent.setup();
        fleetOf(2);
        const setThrottle = vi.spyOn(useLobby.getState(), 'setThrottle');
        render(<MatchScreen />);

        // Already at slow. A command that changes nothing, repeated for as long as the key is
        // held, is traffic the match does not need.
        await user.keyboard('1');
        await user.keyboard('f');

        expect(setThrottle).not.toHaveBeenCalled();
      });

      it('does nothing with no boat selected', async () => {
        const user = userEvent.setup();
        seat();
        const setThrottle = vi.spyOn(useLobby.getState(), 'setThrottle');
        render(<MatchScreen />);
        // A live match opens with boat one selected, so the empty selection is put back by hand
        // — the state a spectator has for the whole match.
        act(() => {
          useMatch.getState().select(null);
        });

        await user.keyboard('r');

        expect(setThrottle).not.toHaveBeenCalled();
      });
    });
  });

  // ── routes ──────────────────────────────────────────────────────────────────

  /*
   * The scope draws the whole team's plans, not only the commanded boat's, with everything but
   * the selection dropped to background weight (`render/ScopeHost.tsx#drawRoutes`). The weighting
   * is a drawing decision and lives there; what the screen owes it is the list and the flags.
   */
  describe('the routes handed to the scope', () => {
    /**
     * A seated match, plus the two halves of its friendly fleet by id.
     *
     * `mine` is what this player commands and `mate` is the teammate's boat — on the same view
     * frame, because it is friendly, and absent from the owned half of `setup.fleet`. That is the
     * distinction the `mine` flag draws, and it is why the getter has to join the two halves of
     * the projection rather than read the frame alone.
     */
    function seatFleet() {
      const fixture = seat();
      const mine = fixture.setup.fleet
        .filter((profile) => profile.owner === YOU)
        .map((profile) => profile.id);
      const mate = fixture.view.boats.find((boat) => !mine.includes(boat.id))?.id;
      expect(mate).toBeDefined();
      return { ...fixture, mine, mate: mate! };
    }

    /** Put the named boats under way towards one waypoint each. The rest keep holding station. */
    function sail(fixture: ReturnType<typeof seatFleet>, ids: readonly number[]): void {
      act(() => {
        useMatch.setState({
          views: {
            [fixture.setup.matchId]: {
              ...fixture.view,
              boats: fixture.view.boats.map((boat) =>
                ids.includes(boat.id)
                  ? {
                      ...boat,
                      order: { kind: 'transit' as const, waypoints: [{ x: 900, y: 400 }] },
                    }
                  : boat,
              ),
            },
          },
          revision: 2,
        });
      });
    }

    it("carries the whole team's plans, and says whose each is", () => {
      const fixture = seatFleet();
      sail(fixture, [fixture.mine[0]!, fixture.mate]);
      render(<MatchScreen />);

      const routes = scope.routes?.() ?? [];
      expect([...routes].map((route) => route.boatId).sort()).toEqual(
        [fixture.mine[0]!, fixture.mate].sort(),
      );
      expect(routes.find((route) => route.boatId === fixture.mine[0])?.mine).toBe(true);
      expect(routes.find((route) => route.boatId === fixture.mate)?.mine).toBe(false);
      expect(routes.every((route) => route.waypoints.length === 1)).toBe(true);
    });

    it('marks the selection, and moves the mark when the selection does', () => {
      const fixture = seatFleet();
      sail(fixture, [fixture.mine[0]!, fixture.mine[1]!, fixture.mate]);
      render(<MatchScreen />);

      // The match opens on boat one, which is the mark the scope draws at full strength.
      const marked = () => scope.routes?.()?.filter((route) => route.selected) ?? [];
      expect(marked().map((route) => route.boatId)).toEqual([fixture.mine[0]]);

      act(() => {
        useMatch.getState().select(fixture.mine[1]!);
      });
      expect(marked().map((route) => route.boatId)).toEqual([fixture.mine[1]]);

      // A teammate's boat can be selected by clicking its hull, and it is still only a mark:
      // exactly one route is ever the commanded one.
      act(() => {
        useMatch.getState().select(fixture.mate);
      });
      expect(marked().map((route) => route.boatId)).toEqual([fixture.mate]);
    });

    it('leaves out a boat holding station', () => {
      seatFleet();
      render(<MatchScreen />);

      // Deployment gives every boat a holding order, so this is the opening state of a match.
      expect(scope.routes?.()).toEqual([]);
    });

    it('leaves out a wreck, whatever order it died under', () => {
      const fixture = seatFleet();
      sail(fixture, [fixture.mine[0]!]);
      act(() => {
        const view = activeView(useMatch.getState())!;
        useMatch.setState({
          views: {
            [fixture.setup.matchId]: {
              ...view,
              boats: view.boats.map((boat) =>
                boat.id === fixture.mine[0] ? { ...boat, status: 'destroyed' as const } : boat,
              ),
            },
          },
          revision: 3,
        });
      });
      render(<MatchScreen />);

      expect(scope.routes?.()).toEqual([]);
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
      // A live match opens with boat one selected, so the empty selection is put back by hand.
      // The state is still real — it is what the store holds between `match.started` and the
      // first frame, and what a spectator has for the whole match.
      act(() => {
        useMatch.getState().select(null);
      });

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
    // The target is a count of captures now, not a running per-second total — one point per
    // objective taken (`match/objectives.ts`), so `DEFAULT_SCORE_TARGET` is single figures.
    expect(
      screen.getByText(new RegExp(`first to ${String(DEFAULT_SCORE_TARGET)}`, 'i')),
    ).toBeTruthy();
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
