/**
 * @vitest-environment jsdom
 *
 * The firing interface: sub-selecting tubes, firing them, and choosing what goes in next.
 *
 * Three bindings share one keyboard here and getting the sharing right is most of what these
 * tests are for. A bare digit picks a boat, **ctrl** and a digit arms one of its tubes, and
 * **Enter** means the load picker while a tube is armed and the chat box when none is. A
 * regression in any of those is a control that silently does the wrong thing under pressure.
 *
 * The trigger itself — **space**, aimed at the cursor — lives in the scope, which is mocked here
 * down to the callback it fires. What the shot *carries* is this screen's half, and that is what
 * these assert.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLobby } from '../src/state/lobby.js';
import { useMatch } from '../src/state/match.js';
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

describe('arming tubes', () => {
  it('takes ctrl and a digit, and the digit is the tube’s rather than the boat’s', () => {
    const { boat } = seated();
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });
    expect(useMatch.getState().armedTubes).toEqual([1]);
    // And the boat selection has not moved: the modifier is the level, so ctrl+2 never means
    // "pick the second boat".
    expect(useMatch.getState().selected).toBe(boat.id);
  });

  it('disarms on a second press, so the same key is the whole control', () => {
    seated();
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    expect(useMatch.getState().armedTubes).toEqual([]);
  });

  it('keeps the set in tube order however the keys were pressed', () => {
    // The salvo leaves in the order the pips are drawn in, which is the only order the player
    // could have predicted from the panel.
    seated();
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    expect(useMatch.getState().armedTubes).toEqual([0, 1]);
  });

  it('ignores a digit past the boat’s tube count, leaving it to the browser', () => {
    // Ctrl+8 is a tab switch and there is no eighth tube. Taking it would be taking back
    // something the player expects to keep working, for nothing.
    seated();
    fireEvent.keyDown(window, { key: '8', ctrlKey: true });
    expect(useMatch.getState().armedTubes).toEqual([]);
  });

  it('does nothing with no boat selected', () => {
    // The screen now presses `1` for the player as soon as the fleet is on the water, so the
    // state has to be arranged rather than assumed — it is the one a spectator sits in for the
    // whole match, and the one every match is in until its first view frame lands.
    seatMatch();
    render(<MatchScreen />);
    useMatch.getState().select(null);
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    expect(useMatch.getState().armedTubes).toEqual([]);
  });

  it('forgets the set when the selection moves to a different boat', () => {
    // A tube index means a different tube on a different boat, and carrying it across would
    // fire the wrong one.
    const fixture = seated();
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    expect(useMatch.getState().armedTubes).toEqual([0]);

    const other = fixture.setup.fleet.find(
      (candidate) =>
        candidate.owner === fixture.setup.you.accountId && candidate.id !== fixture.boat.id,
    );
    useMatch.getState().select(other?.id ?? null);
    expect(useMatch.getState().armedTubes).toEqual([]);
  });

  it('keeps the set when the same boat is re-selected', () => {
    // A stray click on the hull the player is aiming from must not throw away the tubes they
    // just armed.
    const { boat } = seated();
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    useMatch.getState().select(boat.id);
    expect(useMatch.getState().armedTubes).toEqual([0]);
  });

  it('marks the armed pip on the selected row, and only there', () => {
    const fixture = seated();
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });

    expect(tubes(fixture.boat.name)[0]?.getAttribute('aria-pressed')).toBe('true');
    const other = fixture.setup.fleet.find(
      (candidate) =>
        candidate.owner === fixture.setup.you.accountId && candidate.id !== fixture.boat.id,
    );
    // A highlighted pip on a boat the next click would not fire from would be actively
    // misleading, so an unselected row shows none.
    for (const pip of tubes(other?.name ?? '')) {
      expect(pip.getAttribute('aria-pressed')).toBe('false');
    }
  });
});

describe('firing', () => {
  it('sends the armed tubes and the point the cursor was on', () => {
    const { boat } = seated();
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });

    fireAt?.({ x: 1200, y: 400 });
    expect(fireTubes).toHaveBeenCalledWith(boat.id, [0, 1], { x: 1200, y: 400 });
  });

  it('sends an empty list with nothing armed, which the server reads as "the first tube"', () => {
    // The bare space press, and the shot a player who has never read a key binding will take.
    const { boat } = seated();
    fireAt?.({ x: 900, y: 200 });
    expect(fireTubes).toHaveBeenCalledWith(boat.id, [], { x: 900, y: 200 });
  });

  it('keeps the sub-selection afterwards, because it is a posture rather than a shot', () => {
    seated();
    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    fireAt?.({ x: 900, y: 200 });
    expect(useMatch.getState().armedTubes).toEqual([0]);
  });

  it('does nothing with no boat selected', () => {
    // Deselected on purpose — see the note on the same case in `arming tubes`.
    seatMatch();
    render(<MatchScreen />);
    useMatch.getState().select(null);
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

  it('opens on Enter for the tube most recently armed', async () => {
    seated();
    fireEvent.keyDown(window, { key: '2', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect((await screen.findByRole('dialog')).getAttribute('aria-label')).toMatch(/tube 2/i);
  });

  it('leaves Enter to the chat box when no tube is armed', () => {
    // Both listen on `window`, and which of them runs first is mount order — a detail neither
    // should rely on. The armed set is what decides, and with none the chat box wins.
    seated();
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
});
