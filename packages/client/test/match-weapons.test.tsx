/**
 * @vitest-environment jsdom
 *
 * The firing interface: which tube is up, firing it, and choosing what goes in next.
 *
 * **Every boat has exactly one tube armed, always** (`state/match.ts#armedTube`). Space fires it
 * and steps to the next, wrapping; ctrl and a digit aims the selection at a tube outright; ← and →
 * step it without firing; and the choice is remembered per boat, so switching away and back finds
 * the boat where it was left.
 *
 * Four bindings share one keyboard here and getting the sharing right is most of what these tests
 * are for. A bare digit picks a boat, ctrl and a digit picks one of its tubes, **shift** and a
 * digit opens that tube's load picker, and **`E`** opens the picker for the tube that is up and
 * then takes a load from it. **Enter** is chat's and nothing else's. A regression in any of those
 * is a control that silently does the wrong thing under pressure.
 *
 * The trigger itself — **space**, aimed at the cursor — lives in the scope, which is mocked here
 * down to the callback it fires. What the shot *carries* is this screen's half, and that is what
 * these assert.
 */
import { DEPLOYABLE_WEAPON_IDS, type WeaponId } from '@seg/shared';
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLobby } from '../src/state/lobby.js';
import { armedTubeOf, useMatch } from '../src/state/match.js';
import { MatchScreen } from '../src/ui/MatchScreen.js';
import { seatMatch, stubCanvas } from './match-fixture.js';

stubCanvas();

/** The scope, reduced to the one thing these tests drive: the space bar's shot. */
let fireAt: ((to: { x: number; y: number }) => void) | undefined;

vi.mock('../src/render/ScopeHost.js', () => ({
  ScopeHost: ({
    controls,
    onFire,
  }: {
    controls?: { current: { lookAt: () => void; dragging: () => boolean } | null };
    onFire?: (to: { x: number; y: number }) => void;
  }) => {
    if (controls !== undefined)
      controls.current = { lookAt: () => undefined, dragging: () => false };
    fireAt = onFire;
    return <div data-testid="scope" />;
  },
}));

const real = {
  fireTubes: useLobby.getState().fireTubes,
  loadTube: useLobby.getState().loadTube,
};

let fireTubes: ReturnType<typeof vi.fn>;
let loadTube: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fireTubes = vi.fn();
  loadTube = vi.fn();
  useLobby.setState({ fireTubes, loadTube });
});

afterEach(() => {
  useLobby.setState(real);
  useMatch.getState().clear();
  fireAt = undefined;
  cleanup();
});

/** Seat a match, render the screen, and select the player's first boat. */
function seated() {
  const fixture = seatMatch();
  render(<MatchScreen />);
  const first = fixture.setup.fleet.find((boat) => boat.owner === fixture.setup.you.accountId);
  if (first === undefined) throw new Error('the fixture has no commandable boat');
  useMatch.getState().select(first.id);
  return { ...fixture, boat: first };
}

/** The tube buttons on a boat's row, in tube order. */
function tubes(name: string): readonly HTMLElement[] {
  return within(screen.getByRole('group', { name: `${name} tubes` })).getAllByRole('button');
}

/** The open load picker, or `null`. jest-dom is not wired in, so assert on the DOM directly. */
function picker(): HTMLElement | null {
  return screen.queryByRole('dialog', { name: /tube/i });
}

/**
 * Shift and a number, as the *browser* delivers it.
 *
 * `key` is the shifted character — `!` for the 1 — because that is what a US keyboard actually
 * sends, and a binding that matched on it would break on the next layout along. `code` is the
 * key's position, which is what the handler reads (`hud/rows.ts#digitIndexFor`).
 */
function shiftDigit(digit: number): void {
  fireEvent.keyDown(window, {
    key: ')!@#$%^&*('[digit],
    code: `Digit${String(digit)}`,
    shiftKey: true,
  });
}

/**
 * Queue a different load behind a tube, the way an accepted `weapon.load` would.
 *
 * Arranged on the view rather than by driving the picker, because `loadTube` is a spy here: the
 * command never reaches a server, so nothing would come back to move `next`, and a test about a
 * tube whose queue has gone stale needs that gap opened by hand.
 */
function queueNext(boatId: number, index: number, weapon: WeaponId): void {
  act(() => {
    useMatch.setState((state) => {
      const matchId = state.matchId ?? '';
      const view = state.views[matchId];
      if (view === undefined) return state;
      return {
        views: {
          ...state.views,
          [matchId]: {
            ...view,
            own: view.own.map((own) =>
              own.id === boatId
                ? {
                    ...own,
                    tubes: own.tubes.map((tube) =>
                      tube.index === index ? { ...tube, next: weapon } : tube,
                    ),
                  }
                : own,
            ),
          },
        },
        revision: state.revision + 1,
      };
    });
  });
}

/** The tube the store says a boat will fire next. The whole of the sub-selection. */
function armed(boat: number): number {
  return armedTubeOf(useMatch.getState(), boat);
}

/** How many tubes a boat has, off the view frame the panel reads. */
function tubeCount(boat: number): number {
  const state = useMatch.getState();
  return state.views[state.matchId ?? '']?.own.find((own) => own.id === boat)?.tubes.length ?? 0;
}

/**
 * Put a tube into its reload cycle, the way an accepted `weapon.fire` would.
 *
 * Arranged on the view for the reason `queueNext` gives: `fireTubes` is a spy here, so nothing
 * comes back from a server to move the tube's status.
 */
function reloading(boatId: number, index: number): void {
  act(() => {
    useMatch.setState((state) => {
      const matchId = state.matchId ?? '';
      const view = state.views[matchId];
      if (view === undefined) return state;
      return {
        views: {
          ...state.views,
          [matchId]: {
            ...view,
            own: view.own.map((own) =>
              own.id === boatId
                ? {
                    ...own,
                    tubes: own.tubes.map((tube) =>
                      tube.index === index
                        ? { ...tube, status: 'reloading' as const, readyInSeconds: 30 }
                        : tube,
                    ),
                  }
                : own,
            ),
          },
        },
        revision: state.revision + 1,
      };
    });
  });
}

describe('choosing which tube fires', () => {
  it('opens the match on the first tube, without anyone pressing anything', () => {
    // "Exactly one tube is always up" has to hold from the first frame, or the opening shot of a
    // match would be the one gesture in the game with no defined target.
    const { boat } = seated();
    expect(armed(boat.id)).toBe(0);
  });

  it('takes ctrl and a digit, and the digit is the tube’s rather than the boat’s', () => {
    const { boat } = seated();
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });
    expect(armed(boat.id)).toBe(1);
    // And the boat selection has not moved: the modifier is the level, so ctrl+2 never means
    // "pick the second boat".
    expect(useMatch.getState().selected).toBe(boat.id);
  });

  it('stays put on a second press of the same digit, where it used to disarm', () => {
    // There is no "nothing armed" state to go back to any more, so a key that undid itself would
    // have to guess which other tube the player meant.
    const { boat } = seated();
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });
    expect(armed(boat.id)).toBe(1);
  });

  it('ignores a digit past the boat’s tube count, leaving it to the browser', () => {
    // Ctrl+8 is a tab switch and there is no eighth tube. Taking it would be taking back
    // something the player expects to keep working, for nothing.
    const { boat } = seated();
    fireEvent.keyDown(window, { key: '8', ctrlKey: true });
    expect(armed(boat.id)).toBe(0);
  });

  it('does nothing with no boat selected', () => {
    // The screen now presses `1` for the player as soon as the fleet is on the water, so the
    // state has to be arranged rather than assumed — it is the one a spectator sits in for the
    // whole match, and the one every match is in until its first view frame lands.
    seatMatch();
    render(<MatchScreen />);
    useMatch.getState().select(null);
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    expect(useMatch.getState().armedTube).toEqual({});
  });

  it('remembers each boat’s tube across a switch away and back', () => {
    // The whole reason the selection is keyed by boat rather than held flat: a player who has
    // walked one boat round to its third tube still has it there after a detour.
    const fixture = seated();
    const other = fixture.setup.fleet.find(
      (candidate) =>
        candidate.owner === fixture.setup.you.accountId && candidate.id !== fixture.boat.id,
    )!;

    fireEvent.keyDown(window, { key: '2', ctrlKey: true });
    expect(armed(fixture.boat.id)).toBe(1);

    act(() => {
      useMatch.getState().select(other.id);
    });
    // The other boat is on its own first tube, untouched by what was done to the first. It is the
    // Heavy of the fixture's pair, so tube three exists on it and not on the boat before it —
    // which is also why the index cannot simply be carried across.
    expect(armed(other.id)).toBe(0);
    fireEvent.keyDown(window, { key: '3', ctrlKey: true });

    act(() => {
      useMatch.getState().select(fixture.boat.id);
    });
    expect(armed(fixture.boat.id)).toBe(1);
    expect(armed(other.id)).toBe(2);
  });

  describe('the sideways arrows', () => {
    it('step to the next tube and the previous one, firing nothing', () => {
      const { boat } = seated();

      fireEvent.keyDown(window, { key: 'ArrowRight' });
      expect(armed(boat.id)).toBe(1);
      fireEvent.keyDown(window, { key: 'ArrowLeft' });
      expect(armed(boat.id)).toBe(0);

      expect(fireTubes).not.toHaveBeenCalled();
    });

    it('wraps at both ends', () => {
      const { boat } = seated();
      const count = tubeCount(boat.id);
      expect(count).toBeGreaterThan(1);

      // Back off the first tube is the last one, not a negative index.
      fireEvent.keyDown(window, { key: 'ArrowLeft' });
      expect(armed(boat.id)).toBe(count - 1);
      fireEvent.keyDown(window, { key: 'ArrowRight' });
      expect(armed(boat.id)).toBe(0);
    });

    it('leaves the arrows to the load picker while one is open', async () => {
      // The picker walks its list of loads with the arrows (`hud/TubePicker`). Without the
      // `ownsKeyboard` guard, choosing a torpedo would quietly move the firing tube behind it.
      const { boat } = seated();
      shiftDigit(1);
      const panel = await screen.findByRole('dialog');
      within(panel).getAllByRole('button')[0]!.focus();

      fireEvent.keyDown(window, { key: 'ArrowRight' });

      expect(armed(boat.id)).toBe(0);
    });
  });

  it('marks the armed pip on the selected row, and only there', () => {
    const fixture = seated();
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });

    const pips = tubes(fixture.boat.name);
    expect(pips[1]?.getAttribute('aria-pressed')).toBe('true');
    // Exactly one, which is the invariant the whole change is about.
    expect(pips.filter((pip) => pip.getAttribute('aria-pressed') === 'true')).toHaveLength(1);

    const other = fixture.setup.fleet.find(
      (candidate) =>
        candidate.owner === fixture.setup.you.accountId && candidate.id !== fixture.boat.id,
    );
    // Every boat remembers a tube, but only the selected boat's is the one space would fire — a
    // highlighted pip on a row the next press would not fire from would be actively misleading.
    for (const pip of tubes(other?.name ?? '')) {
      expect(pip.getAttribute('aria-pressed')).toBe('false');
    }
  });
});

describe('firing', () => {
  it('sends the armed tube alone, and the point the cursor was on', () => {
    const { boat } = seated();
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });

    fireAt?.({ x: 1200, y: 400 });
    expect(fireTubes).toHaveBeenCalledWith(boat.id, [1], { x: 1200, y: 400 });
  });

  it('fires the first tube on a bare press, with nothing touched', () => {
    // The shot a player who has never read a key binding will take.
    const { boat } = seated();
    fireAt?.({ x: 900, y: 200 });
    expect(fireTubes).toHaveBeenCalledWith(boat.id, [0], { x: 900, y: 200 });
  });

  it('steps to the next tube after the shot, and wraps past the last', () => {
    // Space, space, space walks the boat's tubes in order: the salvo that used to cost a
    // ctrl-press per tube to set up.
    const { boat } = seated();
    const count = tubeCount(boat.id);
    expect(count).toBeGreaterThan(1);

    for (let shot = 0; shot < count; shot += 1) {
      act(() => {
        fireAt?.({ x: 900, y: 200 });
      });
      expect(fireTubes).toHaveBeenNthCalledWith(shot + 1, boat.id, [shot], { x: 900, y: 200 });
    }

    // Round to the beginning, rather than sticking on the last tube.
    expect(armed(boat.id)).toBe(0);
  });

  it('steps past a tube that is still reloading rather than sticking on it', () => {
    // The tube refuses the shot at the server and the selection moves along anyway. A space bar
    // that stuck on a tube with thirty seconds left on it, while three loaded ones sat behind it,
    // would be the worst possible behaviour of the one key a player presses under fire.
    const { boat } = seated();
    reloading(boat.id, 0);

    act(() => {
      fireAt?.({ x: 900, y: 200 });
    });

    expect(fireTubes).toHaveBeenCalledWith(boat.id, [0], { x: 900, y: 200 });
    expect(armed(boat.id)).toBe(1);
  });

  it('does nothing with no boat selected', () => {
    // Deselected on purpose — see the note on the same case in `choosing which tube fires`.
    seatMatch();
    render(<MatchScreen />);
    useMatch.getState().select(null);
    fireAt?.({ x: 900, y: 200 });
    expect(fireTubes).not.toHaveBeenCalled();
  });

  it('does nothing with a teammate’s boat selected', () => {
    // A teammate's hull can be picked by clicking it on the scope, and there is no tube state for
    // it — firing from one is a command the server would refuse, and there is nothing to step
    // through either, so the whole gesture is dropped rather than half-performed.
    const fixture = seatMatch();
    render(<MatchScreen />);
    const mate = fixture.view.boats.find(
      (candidate) =>
        !fixture.setup.fleet.some(
          (profile) => profile.owner === fixture.setup.you.accountId && profile.id === candidate.id,
        ),
    );
    expect(mate).toBeDefined();
    act(() => {
      useMatch.getState().select(mate!.id);
    });

    fireAt?.({ x: 900, y: 200 });

    expect(fireTubes).not.toHaveBeenCalled();
  });
});

describe('the load picker', () => {
  it('opens on a click on a tube pip', async () => {
    const fixture = seated();
    await userEvent.click(tubes(fixture.boat.name)[0]!);
    expect(picker()?.getAttribute('aria-label')).toMatch(/tube 1/i);
  });

  it('leaves Enter to the chat box, armed tube or not', () => {
    /*
     * Enter used to open the picker for the tube most recently armed, and fall through to chat
     * when nothing was armed. A tube is now always armed, so that guard would be true for the
     * whole match and chat would have no key at all — the binding is gone and Enter is
     * unambiguously chat's, here and inside the panel. The picker has `E`, shift+number, and the
     * pip.
     */
    const { boat } = seated();
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });
    expect(armed(boat.id)).toBe(1);

    fireEvent.keyDown(window, { key: 'Enter' });

    expect(picker()).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy();
  });

  it('offers only the loads the weapons phase can actually deploy', async () => {
    // The four loiter loads are marked undeployable in the content table. Offering one would
    // let a player quietly disarm a tube.
    const { boat } = seated();
    await userEvent.click(tubes(boat.name)[0]!);

    const panel = picker();
    expect(panel).not.toBeNull();
    expect(within(panel!).getByText('Standard Torpedo')).toBeTruthy();
    expect(within(panel!).getByText('Super-cavitating Torpedo')).toBeTruthy();
    expect(within(panel!).queryByText('Passive Sonar Drone')).toBeNull();
    expect(within(panel!).queryByText('Mine')).toBeNull();
  });

  it('queues a load on a plain click', async () => {
    const fixture = seated();
    await userEvent.click(tubes(fixture.boat.name)[0]!);
    await userEvent.click(screen.getByText('Super-cavitating Torpedo'));

    expect(loadTube).toHaveBeenCalledWith(fixture.boat.id, 0, 'super-cavitating', false);
    // And the panel puts itself away — the decision is made.
    expect(picker()).toBeNull();
  });

  it('swaps on a shift-click, which costs the tube a full cycle', async () => {
    const fixture = seated();
    await userEvent.click(tubes(fixture.boat.name)[0]!);
    // `fireEvent` rather than `userEvent`, because the modifier has to be on the click event
    // itself: the handler reads `event.shiftKey`, and `userEvent` models a modifier as a
    // separate held key rather than as a property of the press.
    fireEvent.click(screen.getByText('Super-cavitating Torpedo'), { shiftKey: true });

    expect(loadTube).toHaveBeenCalledWith(fixture.boat.id, 0, 'super-cavitating', true);
  });

  it('will not swap to the load already in the tube — that spends a cycle to change nothing', async () => {
    const fixture = seated();
    await userEvent.click(tubes(fixture.boat.name)[0]!);
    fireEvent.click(screen.getByText('Standard Torpedo'), { shiftKey: true });

    expect(loadTube).toHaveBeenCalledWith(fixture.boat.id, 0, 'standard', false);
  });

  it('closes on Escape', async () => {
    const fixture = seated();
    await userEvent.click(tubes(fixture.boat.name)[0]!);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(picker()).toBeNull();
  });

  it('opens on shift and the tube’s number', async () => {
    const { boat } = seated();
    shiftDigit(2);
    expect((await screen.findByRole('dialog')).getAttribute('aria-label')).toMatch(/tube 2/i);
    // And the tube is *not* armed by it: choosing a load and choosing what fires next are
    // different jobs, and arming as a side effect would change what the next shot fires.
    expect(armed(boat.id)).toBe(0);
  });

  it('ignores shift and a digit past the boat’s tube count', () => {
    seated();
    shiftDigit(8);
    expect(picker()).toBeNull();
  });

  it('opens on the load the tube already has queued, and takes it on E', async () => {
    const { boat } = seated();
    shiftDigit(1);
    const panel = await screen.findByRole('dialog');

    fireEvent.keyDown(panel, { key: 'e' });

    // Standard is what a tube deploys holding, so an unmoved highlight re-queues it — E straight
    // away is a no-op rather than a surprise.
    expect(loadTube).toHaveBeenCalledWith(boat.id, 0, 'standard', false);
    expect(picker()).toBeNull();
  });

  it('walks the list with the arrow keys', async () => {
    const { boat } = seated();
    shiftDigit(1);
    const panel = await screen.findByRole('dialog');

    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    fireEvent.keyDown(panel, { key: 'e' });

    expect(loadTube).toHaveBeenCalledWith(boat.id, 0, 'super-cavitating', false);
  });

  it('wraps at the ends of a short list', async () => {
    const { boat } = seated();
    shiftDigit(1);
    const panel = await screen.findByRole('dialog');

    // Up from the first row is the last one, whatever the table happens to hold — asserted
    // against `DEPLOYABLE_WEAPON_IDS` rather than against a load's name so that adding one does
    // not turn a test about wrapping into a test about the weapon table.
    fireEvent.keyDown(panel, { key: 'ArrowUp' });
    fireEvent.keyDown(panel, { key: 'e' });

    const last = DEPLOYABLE_WEAPON_IDS[DEPLOYABLE_WEAPON_IDS.length - 1];
    expect(last).not.toBe('standard');
    expect(loadTube).toHaveBeenCalledWith(boat.id, 0, last, false);
  });

  it('swaps on shift-E, the same as a shift-click', async () => {
    const { boat } = seated();
    shiftDigit(1);
    const panel = await screen.findByRole('dialog');

    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    fireEvent.keyDown(panel, { key: 'e', shiftKey: true });

    expect(loadTube).toHaveBeenCalledWith(boat.id, 0, 'super-cavitating', true);
  });

  /*
   * Enter is chat's alone now, at both levels: it no longer opens this panel and it no longer
   * takes a load from it. The panel still has to *take* the key and drop it, because the
   * highlight is real focus and every row is a `<button>` — left alone, the browser's own "Enter
   * activates the focused button" would go on choosing loads with the key that is supposed to
   * have stopped.
   */
  describe('Enter', () => {
    it('chooses nothing, and leaves the panel open', async () => {
      seated();
      shiftDigit(1);
      const panel = await screen.findByRole('dialog');

      fireEvent.keyDown(panel, { key: 'Enter' });

      expect(loadTube).not.toHaveBeenCalled();
      expect(picker()).not.toBeNull();
    });

    it('does not reach the browser’s click on the focused row either', async () => {
      // The one that would slip through a handler that only stopped propagation: `keyDown` alone
      // does not synthesise the activation, so the guard is asserted on the flag the browser
      // reads rather than on a click that jsdom will not fire.
      seated();
      shiftDigit(1);
      const panel = await screen.findByRole('dialog');
      const row = within(panel).getAllByRole('button')[0]!;
      row.focus();

      const press = createEvent.keyDown(row, { key: 'Enter' });
      fireEvent(row, press);

      expect(press.defaultPrevented).toBe(true);
      expect(loadTube).not.toHaveBeenCalled();
    });

    it('does not open the chat box behind the panel', () => {
      // Chat's guard is `ownsKeyboard`, and this panel is a focused `[role="dialog"]` — so the
      // key is simply inert for as long as it is up, rather than doing two things at once.
      seated();
      shiftDigit(1);

      fireEvent.keyDown(window, { key: 'Enter' });

      expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    });
  });

  it('leaves the bare keys live after a load is taken, rather than handing the keyboard to chat', async () => {
    // The full loop a player actually runs: choose a load with the keyboard, then reach for the
    // next command. If the press leaked to the window the chat box would be focused and E — and
    // every other bare key in the HUD — would die to the `isTyping` guard.
    const { boat } = seated();
    shiftDigit(1);
    const panel = await screen.findByRole('dialog');
    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    fireEvent.keyDown(panel, { key: 'e' });
    expect(loadTube).toHaveBeenCalledWith(boat.id, 0, 'super-cavitating', false);
    expect(picker()).toBeNull();

    // The queued load lands on the next view frame, the way an accepted weapon.load would.
    queueNext(boat.id, 0, 'super-cavitating');
    fireEvent.keyDown(window, { key: 'e' });

    expect(picker()?.getAttribute('aria-label')).toMatch(/tube 1/i);
  });
});

/*
 * `E` is the whole loadout decision on one key, at two levels: with the panel shut it opens the
 * picker for the tube that is up, and with it open it walks the loads — plain to queue the next
 * one, shift to queue it and empty the tube to load it now.
 *
 * It replaces `C`, which ejected and reloaded every stale tube on the boat at once. That was the
 * "load it now" gesture from before there was a single armed tube to hang one off; shift+`E` is
 * the same idea aimed at the tube the player is looking at.
 */
describe('the load key', () => {
  it('opens the picker on the tube that is up, and only opens it', () => {
    const { boat } = seated();
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });

    fireEvent.keyDown(window, { key: 'e' });

    expect(picker()?.getAttribute('aria-label')).toMatch(/tube 2/i);
    // The opening press commits nothing: a player reaching for E to see what a tube is holding
    // must not change what it is holding by looking.
    expect(loadTube).not.toHaveBeenCalled();
    expect(armed(boat.id)).toBe(1);
  });

  it('opens on shift too, so the key is never dead', () => {
    // Shift only starts to mean something once there is a load to step *from*. A shift+E that did
    // nothing until the panel happened to be open would work or not depending on invisible state.
    seated();
    fireEvent.keyDown(window, { key: 'E', shiftKey: true });
    expect(picker()).not.toBeNull();
  });

  it('takes the load the walk landed on, and shuts the panel', async () => {
    const { boat } = seated();
    fireEvent.keyDown(window, { key: 'e' });
    const panel = await screen.findByRole('dialog');

    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    fireEvent.keyDown(panel, { key: 'e' });

    expect(loadTube).toHaveBeenCalledWith(boat.id, 0, DEPLOYABLE_WEAPON_IDS[1], false);
    expect(picker()).toBeNull();
  });

  it('takes what the panel opened on when the walk is skipped', async () => {
    // The highlight starts on the load the tube already has queued, so E straight after E is a
    // no-op rather than a surprise — the same bargain the panel has always made on opening.
    const { boat } = seated();
    fireEvent.keyDown(window, { key: 'e' });
    const panel = await screen.findByRole('dialog');

    fireEvent.keyDown(panel, { key: 'e' });

    expect(loadTube).toHaveBeenCalledWith(boat.id, 0, DEPLOYABLE_WEAPON_IDS[0], false);
  });

  it('empties the tube and reloads on shift, which is the swap a shift-click makes', async () => {
    const { boat } = seated();
    fireEvent.keyDown(window, { key: 'e' });
    const panel = await screen.findByRole('dialog');

    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    fireEvent.keyDown(panel, { key: 'e', shiftKey: true });

    expect(loadTube).toHaveBeenCalledWith(boat.id, 0, DEPLOYABLE_WEAPON_IDS[1], true);
  });

  it('will not swap to the load already in the tube — that spends a cycle to change nothing', async () => {
    const { boat } = seated();
    fireEvent.keyDown(window, { key: 'e' });
    const panel = await screen.findByRole('dialog');

    // Shift on the load the tube is already holding: it is still queued, and the swap flag comes
    // off because there is nothing worth ejecting.
    fireEvent.keyDown(panel, { key: 'e', shiftKey: true });

    expect(loadTube).toHaveBeenCalledWith(boat.id, 0, DEPLOYABLE_WEAPON_IDS[0], false);
  });

  it('does not reach the window and put the panel straight back up', async () => {
    // The fleet list binds E on the window to open the picker, and taking a load closes it — so a
    // press that leaked through would find no panel and immediately open a new one, on whichever
    // tube is armed rather than on this one.
    seated();
    shiftDigit(2);
    const panel = await screen.findByRole('dialog');
    expect(panel.getAttribute('aria-label')).toMatch(/tube 2/i);

    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    fireEvent.keyDown(panel, { key: 'e' });
    window.removeEventListener('keydown', seen);

    expect(seen).not.toHaveBeenCalled();
    expect(picker()).toBeNull();
  });

  it('does nothing with no boat selected', () => {
    seatMatch();
    render(<MatchScreen />);
    useMatch.getState().select(null);
    fireEvent.keyDown(window, { key: 'e' });
    expect(picker()).toBeNull();
  });

  it('leaves C to nobody: the old force-reload key is gone', () => {
    const { boat } = seated();
    queueNext(boat.id, 0, 'super-cavitating');

    fireEvent.keyDown(window, { key: 'c' });

    expect(loadTube).not.toHaveBeenCalled();
  });
});
