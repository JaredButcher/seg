/**
 * @vitest-environment jsdom
 *
 * The debug probe panel (`ui/hud/Probe.tsx`).
 *
 * A panel of numbers is normally not worth a test. This one is, for one reason: half of what it
 * shows can be legitimately *absent* — no boat selected, no path through the rock, a return under
 * the threshold — and the failure mode is not a crash but a reading somebody believes. "No path"
 * printed as a dash, or as `0 m`, is a wrong answer delivered by the instrument you would reach
 * for to check an answer.
 */

import type { ProbeReading } from '@seg/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Probe } from '../src/ui/hud/Probe.js';

afterEach(cleanup);

const WATER: ProbeReading = {
  at: { x: 1234, y: 640 },
  depth: 360.4,
  water: true,
  cell: 91,
  noise: 14.24,
  background: 11.5,
  listener: {
    boat: 3,
    from: { x: 400, y: 640 },
    straight: 834,
    range: 910.6,
    loss: 42.14,
    selfNoise: -6,
    floor: 1.21,
    gate: -4.79,
    audible: 37.35,
    imaging: 3.4,
  },
};

/** The value beside a label, as the panel lays them out: a `<dt>` followed by its `<dd>`. */
function valueOf(label: string): string {
  const term = screen.getByText(label);
  return term.nextElementSibling?.textContent ?? '';
}

describe('the probe panel', () => {
  it('says what to do when it has nothing to show', () => {
    render(<Probe reading={null} boatName={null} />);

    expect(screen.getByText(/CTRL\+CLICK/i)).toBeTruthy();
  });

  it('reads the point out in metres and decibels', () => {
    render(<Probe reading={WATER} boatName="S-01" />);

    expect(valueOf('POINT')).toBe('1 234, 640 m');
    expect(valueOf('DEPTH')).toBe('360 m');
    expect(valueOf('NOISE')).toBe('14.2 dB');
    expect(valueOf('BACKGROUND')).toBe('11.5 dB');
    // The geodesic distance first, with the ruler's own answer beside it — the pair is what shows
    // a path bending without either number saying so alone.
    expect(valueOf('RANGE')).toBe('911 m (834 m STRAIGHT)');
    expect(valueOf('MIN AUDIBLE SL')).toBe('37.4 dB');
    expect(valueOf('FROM')).toBe('S-01');
  });

  it('names the boat by id when this client cannot see its name', () => {
    // A probe may be taken against the *other* side's boat, whose name this client was never told.
    render(<Probe reading={WATER} boatName={null} />);

    expect(valueOf('FROM')).toBe('BOAT 3');
  });

  it('says nobody is listening rather than showing blanks', () => {
    render(<Probe reading={{ ...WATER, listener: null }} boatName={null} />);

    expect(valueOf('LISTENER')).toBe('NONE SELECTED');
    // The water's own readings are still there — they never needed anybody to be listening.
    expect(valueOf('NOISE')).toBe('14.2 dB');
    expect(screen.queryByText('RANGE')).toBeNull();
  });

  it('never prints an absent reading as a number', () => {
    const sealed: ProbeReading = {
      ...WATER,
      listener: { ...WATER.listener!, range: null, loss: null, audible: null, imaging: null },
    };
    render(<Probe reading={sealed} boatName="S-01" />);

    // The one that would matter: nothing here may read as "zero metres away".
    expect(valueOf('RANGE')).toBe('NO PATH');
    expect(valueOf('IMAGING')).toBe('UNDER THRESHOLD');
    expect(valueOf('MIN AUDIBLE SL')).toBe('—');
  });

  it('flags rock, and only when it is rock', () => {
    render(<Probe reading={WATER} boatName="S-01" />);
    expect(screen.queryByText('TERRAIN')).toBeNull();
    cleanup();

    render(<Probe reading={{ ...WATER, water: false }} boatName="S-01" />);
    expect(valueOf('TERRAIN')).toContain('IN ROCK');
  });
});
