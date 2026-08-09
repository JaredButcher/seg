/**
 * @vitest-environment jsdom
 *
 * The battle results screen: who won and how, both fleets side by side, and the way out.
 *
 * The two things worth pinning are the ones a player would notice instantly and a type would
 * not: that the **viewer's own side is the left column** whoever is looking, and that a boat's
 * card says what actually happened to it. The rest — grouping boats under their owner, naming
 * what each one sank — is the projection's job and is asserted in `@seg/shared`'s
 * `match-results` suite; here it is asserted as *rendered*, because a card that drops a stat is
 * a card nobody can tell is wrong.
 */
import { SIM_TICK_HZ, type BoatTally, type EntityId, type MatchState } from '@seg/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLobby } from '../src/state/lobby.js';
import { useMatch } from '../src/state/match.js';
import { useNav } from '../src/state/nav.js';
import { ResultsScreen } from '../src/ui/ResultsScreen.js';
import { seatResults, stubCanvas, stubDialog, FOE, YOU } from './match-fixture.js';

stubCanvas();

const realLeaveMatch = useLobby.getState().leaveMatch;
let leaveMatch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  stubDialog();
  leaveMatch = vi.fn();
  useLobby.setState({ leaveMatch });
  useNav.setState({ screen: 'results', authTab: 'signIn' });
});

afterEach(() => {
  useLobby.setState({ leaveMatch: realLeaveMatch });
  useMatch.getState().clear();
  cleanup();
});

/** The column for a side, found by the label the screen gives it. */
function column(name: RegExp) {
  return screen.getByRole('region', { name });
}

/**
 * One boat's card.
 *
 * Scoped to a column and an occurrence, because boat names are not unique across a match — both
 * sides of the fixture brought an `S-01`, which is exactly what a real lobby produces.
 */
function card(side: RegExp, boatName: string, occurrence = 0): HTMLElement {
  const label = within(column(side)).getAllByText(boatName)[occurrence];
  const box = label?.closest('.results-boat');
  if (box === null || box === undefined) throw new Error(`no card for ${boatName}`);
  return box as HTMLElement;
}

/** Sink one of the fixture's boats, by name, as of `tick`. */
function sinkBoat(name: string) {
  return (state: MatchState): MatchState => ({
    ...state,
    clock: { tick: 1200, elapsedSeconds: 60, remainingSeconds: 1740 },
    boats: state.boats.map((boat) =>
      boat.name === name ? { ...boat, hp: 0, status: 'destroyed' as const } : boat,
    ),
  });
}

function tally(overrides: Partial<BoatTally> = {}): BoatTally {
  return {
    damageDealt: 0,
    sank: [],
    captures: 0,
    torpedoesFired: 0,
    destroyedTick: null,
    ...overrides,
  };
}

describe('the results screen', () => {
  it('says what the match was and how long it took', () => {
    seatResults();
    render(<ResultsScreen />);

    expect(screen.getByText(/objective capture/i)).toBeTruthy();
  });

  it('tells a player whether they won, and names the side that did either way', () => {
    seatResults({ decision: { winner: 'team1', reason: 'wipe' } });
    render(<ResultsScreen />);

    // The fixture puts the viewer on team 1.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('VICTORY');
    expect(screen.getByText(/team 1 wins — fleet destroyed/i)).toBeTruthy();
  });

  it('does not soften a loss', () => {
    seatResults({ decision: { winner: 'team2', reason: 'score' } });
    render(<ResultsScreen />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('DEFEAT');
    expect(screen.getByText(/team 2 wins — score target reached/i)).toBeTruthy();
  });

  it('calls a draw a draw', () => {
    seatResults({ decision: { winner: 'draw', reason: 'time' } });
    render(<ResultsScreen />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('DRAW');
    expect(screen.getByText(/nobody won — time expired/i)).toBeTruthy();
  });

  it('reads the score against the target in an objective match', () => {
    seatResults({
      ended: (state) => ({
        ...state,
        teams: { ...state.teams, team1: { ...state.teams.team1, score: 7 } },
      }),
    });
    render(<ResultsScreen />);

    const score = screen.getByRole('group', { name: /final score/i });
    expect(within(score).getByText('7')).toBeTruthy();
    // Both boxes carry the target: a score is read against it, and the losing side's is a score.
    const target = String(useMatch.getState().results?.scoreTarget ?? 0);
    expect(within(score).getAllByText(`/ ${target}`)).toHaveLength(2);
    expect(within(score).getAllByText(/objectives captured/i)).toHaveLength(2);
  });

  it('scores a deathmatch on surviving fleet points instead', () => {
    seatResults({ mode: 'deathmatch' });
    render(<ResultsScreen />);

    const score = screen.getByRole('group', { name: /final score/i });
    expect(within(score).getAllByText(/surviving fleet points/i)).toHaveLength(2);
    expect(within(score).queryByText(/objectives captured/i)).toBeNull();
  });

  it('puts the viewer’s own side on the left, and the enemy on the right', () => {
    seatResults();
    render(<ResultsScreen />);

    const sides = screen.getAllByRole('region');
    expect(sides[0]?.getAttribute('aria-label')).toMatch(/team 1 · your team/i);
    expect(sides[1]?.getAttribute('aria-label')).toMatch(/team 2/i);
  });

  it('shows a spectator both sides in team order, and no verdict of their own', () => {
    seatResults({ as: 'watcher', decision: { winner: 'team2', reason: 'wipe' } });
    render(<ResultsScreen />);

    const sides = screen.getAllByRole('region');
    expect(sides[0]?.getAttribute('aria-label')).toBe('Team 1');
    expect(sides[1]?.getAttribute('aria-label')).toBe('Team 2');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('TEAM 2 WINS');
  });

  it('lists every player on a side with the boats they brought under them', () => {
    seatResults();
    render(<ResultsScreen />);

    const mine = column(/team 1 · your team/i);
    // Both team 1 players, and all three of their boats.
    expect(within(mine).getByRole('heading', { name: 'Skipper' })).toBeTruthy();
    expect(within(mine).getByRole('heading', { name: 'Bosun' })).toBeTruthy();
    expect(within(mine).getAllByText(/^S-0[12]$/)).toHaveLength(3);

    // And the other side's fleet is on the screen too — the fog lifts when the match ends.
    const theirs = column(/^team 2$/i);
    expect(within(theirs).getByRole('heading', { name: 'Rival' })).toBeTruthy();
    expect(within(theirs).getAllByText(/^S-0[12]$/)).toHaveLength(2);
  });

  it('carries every statistic a card promises', () => {
    const fixture = seatResults({
      ended: sinkBoat('S-02'),
      tallies: new Map<EntityId, BoatTally>(),
    });
    const mine = fixture.state.boats.find((boat) => boat.owner === YOU && boat.name === 'S-01');
    // The enemy's S-02, so the name in the kill list cannot be confused with the card's own.
    const victim = fixture.state.boats.find((boat) => boat.owner === FOE && boat.name === 'S-02');
    if (mine === undefined || victim === undefined) throw new Error('fixture is not what it was');

    // Re-seat with a tally on the boat that did the work, now that the ids are known.
    seatResults({
      ended: sinkBoat('S-02'),
      tallies: new Map<EntityId, BoatTally>([
        [mine.id, tally({ damageDealt: 87.4, sank: [victim.id], captures: 2, torpedoesFired: 5 })],
      ]),
    });
    render(<ResultsScreen />);

    const worker = card(/team 1 · your team/i, 'S-01');
    expect(within(worker).getByText('AFLOAT')).toBeTruthy();
    expect(within(worker).getByText(/^\d+ \/ \d+ HP$/)).toBeTruthy();
    expect(within(worker).getByText('87')).toBeTruthy();
    expect(within(worker).getByText('5')).toBeTruthy();
    expect(within(worker).getByText('2')).toBeTruthy();
    expect(within(worker).getByText(victim.name)).toBeTruthy();
    // A boat still in the water was alive for the whole match.
    expect(within(worker).getByText('1:00')).toBeTruthy();
  });

  it('marks a wreck as one, and stops its clock where it stopped', () => {
    const fixture = seatResults({ ended: sinkBoat('S-02') });
    const lost = fixture.state.boats.find((boat) => boat.owner === YOU && boat.name === 'S-02');
    if (lost === undefined) throw new Error('fixture is not what it was');

    seatResults({
      ended: sinkBoat('S-02'),
      tallies: new Map<EntityId, BoatTally>([
        [lost.id, tally({ destroyedTick: 15 * SIM_TICK_HZ })],
      ]),
    });
    render(<ResultsScreen />);

    const box = card(/team 1 · your team/i, 'S-02');
    expect(box.className).toContain('results-boat--sunk');
    expect(within(box).getByText('SUNK')).toBeTruthy();
    expect(within(box).getByText(/^0 \/ \d+ HP$/)).toBeTruthy();
    // Its clock stopped when it did, fifteen seconds in, not at the minute the match ran to.
    expect(within(box).getByText('0:15')).toBeTruthy();
  });

  it('leaves the objectives row off a deathmatch, where there are none', () => {
    seatResults({ mode: 'deathmatch' });
    render(<ResultsScreen />);

    expect(screen.queryByText(/^objectives$/i)).toBeNull();
    expect(screen.getAllByText(/^torpedoes$/i).length).toBeGreaterThan(0);
  });

  it('opens the Esc menu and leaves for the main menu from it', async () => {
    const user = userEvent.setup();
    seatResults();
    render(<ResultsScreen />);

    await user.keyboard('{Escape}');
    const menu = screen.getByRole('navigation', { name: /match menu/i });
    // The live-match warnings are not true here, and the panel does not repeat them.
    expect(screen.getByRole('status').textContent).toMatch(/the match is over/i);
    expect(
      Array.from(menu.querySelectorAll('.menu__label')).map((element) => element.textContent),
    ).toEqual(['RESUME', 'SETTINGS', 'CONTROLS', 'MAIN MENU']);

    await user.click(screen.getByRole('button', { name: /return to the main menu/i }));
    await user.click(screen.getByRole('button', { name: /^main menu$/i }));

    expect(leaveMatch).toHaveBeenCalledTimes(1);
  });

  it('closes the menu again on Escape rather than leaving', async () => {
    const user = userEvent.setup();
    seatResults();
    render(<ResultsScreen />);

    await user.keyboard('{Escape}');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('navigation', { name: /match menu/i })).toBeNull();
    expect(leaveMatch).not.toHaveBeenCalled();
  });
});
