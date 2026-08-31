/**
 * @vitest-environment jsdom
 *
 * The processing statistics panel (`ui/hud/Stats.tsx`).
 *
 * A table of numbers, so what is worth pinning is the handful of places it could quietly mislead:
 * a phase that did not run must not read as a phase that took no time, a mean that is per *run*
 * must not be shown against a column header claiming otherwise, and the one judgement the panel
 * makes — this phase is eating the budget — has to fire on the share rather than on the duration,
 * because the phases run at different rates.
 */

import type { PerfPhaseView, SimStatsView } from '@seg/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Stats } from '../src/ui/hud/Stats.js';

afterEach(cleanup);

function phase(over: Partial<PerfPhaseView> & { phase: PerfPhaseView['phase'] }): PerfPhaseView {
  return { runs: 20, mean: 1.5, peak: 2.5, share: 0.03, ...over };
}

const STATS: SimStatsView = {
  tick: 400,
  window: 40,
  budgetMs: 50,
  phases: [
    phase({ phase: 'world', mean: 0.12, peak: 0.4, share: 0.004 }),
    phase({ phase: 'fields', runs: 20, mean: 12.5, peak: 31.2, share: 0.25 }),
    phase({ phase: 'hulls', runs: 0, mean: 0, peak: 0, share: 0 }),
    phase({ phase: 'acoustics', runs: 20, mean: 18.4, peak: 40.1, share: 0.368 }),
    phase({ phase: 'tick', runs: 40, mean: 19.2, peak: 42, share: 0.384 }),
  ],
  counts: {
    boats: 4,
    torpedoes: 2,
    zones: 3,
    entities: 6,
    sources: 6,
    listeners: 4,
    fieldCells: 41_200,
    lookCells: 18_400,
    reflectorCells: 260,
    clippedFields: 0,
    visionCells: 1_900,
    latticeCells: 225_000,
    waterCells: 138_400,
  },
};

/** The cells of the row a phase label names. */
function rowOf(label: string): string[] {
  const cell = screen.getByText(label);
  const row = cell.closest('tr');
  if (row === null) throw new Error(`no row for ${label}`);
  return [...row.children].map((child) => child.textContent ?? '');
}

describe('the statistics panel', () => {
  it('says it is waiting rather than showing an empty table', () => {
    render(<Stats stats={null} />);

    expect(screen.getByText(/WAITING/i)).toBeTruthy();
  });

  it('reads a phase out as mean, peak and share', () => {
    render(<Stats stats={STATS} />);

    expect(rowOf('FIELDS')).toEqual(['FIELDS', '12.5', '31.2', '25%']);
    // Under 10 ms goes to a hundredth: the range this panel spans is four decades, and a phase
    // reading `0.1` where it means `0.12` is a phase nobody can watch drift.
    expect(rowOf('WORLD')).toEqual(['WORLD', '0.12', '0.40', '<1%']);
  });

  it('prints a phase that did not run as absent, not as zero', () => {
    // The one that would matter: `0.00` next to HULLS reads as "the hull skin is free", where the
    // truth is that the pass did not run in the window at all.
    render(<Stats stats={STATS} />);

    expect(rowOf('HULLS')).toEqual(['HULLS', '—', '—', '—']);
  });

  it('marks a phase eating the budget, and never marks the totals', () => {
    render(<Stats stats={STATS} />);

    const hot = screen.getByText('FIELDS').closest('tr');
    expect(hot?.className).toContain('hud-stats__row--hot');
    // The steps of a solve are indented under the row that contains them, or their shares would
    // read as parts of the budget beside a row that already holds them.
    expect(hot?.className).toContain('hud-stats__row--inner');

    // `ACOUSTICS` and `TICK TOTAL` are sums of rows above them, so marking either would be marking
    // the same milliseconds twice — and both are over the threshold whenever any part is.
    for (const label of ['ACOUSTICS', 'TICK TOTAL']) {
      const total = screen.getByText(label).closest('tr');
      expect(total?.className).toContain('hud-stats__row--total');
      expect(total?.className).not.toContain('hud-stats__row--hot');
      expect(total?.className).not.toContain('hud-stats__row--inner');
    }
  });

  it('says what the numbers are of', () => {
    // The payload carries the window and the budget, so a reader does not have to know the
    // server's tick rate to read their own panel.
    render(<Stats stats={STATS} />);

    expect(screen.getByText(/40 TICKS · 50 MS BUDGET/)).toBeTruthy();
  });

  it('counts the world, and hides the guardrail until it bites', () => {
    render(<Stats stats={STATS} />);

    expect(screen.getByText('FIELD CELLS').nextElementSibling?.textContent).toBe('41 200');
    // The reflection pass walks a different set of cells from the sweep, which is why it is worth
    // its own count beside its own row.
    expect(screen.getByText('LOOK CELLS').nextElementSibling?.textContent).toBe('18 400');
    expect(screen.getByText('HULL CELLS').nextElementSibling?.textContent).toBe('260');
    expect(screen.getByText('WEAPONS').nextElementSibling?.textContent).toBe('2');
    // A permanent zero beside CLIPPED is not news; a non-zero one is the tick budget's guardrail
    // biting, so the row appears only then.
    expect(screen.queryByText('CLIPPED')).toBeNull();
    cleanup();

    render(<Stats stats={{ ...STATS, counts: { ...STATS.counts, clippedFields: 3 } }} />);
    expect(screen.getByText('CLIPPED').nextElementSibling?.textContent).toBe('3');
  });
});
