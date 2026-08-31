/**
 * @vitest-environment jsdom
 *
 * The devtools commands (`debug/console.ts`), and the one piece of them with moving parts.
 *
 * Three of the four acoustic fields are questions about *one boat's* hydrophone, so the overlay
 * has to follow the scope's selection — and that following is a live subscription, which is the
 * kind of thing that silently stops working, fires for the wrong reason, or outlives the command
 * that started it. The rest of the module is argument validation; this is the part worth a test.
 */

import { FIELD_KINDS, type MatchSetup } from '@seg/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDebug } from '../src/debug/state.js';
import { useLobby } from '../src/state/lobby.js';
import { useMatch } from '../src/state/match.js';
import { seatMatch } from './match-fixture.js';

import '../src/debug/console.js';

/** What the console actually asked the server for, in order. */
let asked: { kind: string | null; boat: number | null }[];
/** And the same for the ping-reach switch, which takes a flag rather than a selection. */
let reached: boolean[];
/** And for the statistics panel, which is the one that arms something on the server. */
let measured: boolean[];

function seg(): NonNullable<Window['seg']> {
  const api = window.seg;
  if (api === undefined) throw new Error('the console module hung nothing off the window');
  return api;
}

/** Seat a match whose lobby turned debug mode on, which is what gates every command here. */
function seatDebugMatch(): MatchSetup {
  const fixture = seatMatch();
  const setup: MatchSetup = { ...fixture.setup, debugMode: true };
  useMatch.setState({ setups: { [setup.matchId]: setup } });
  return setup;
}

beforeEach(() => {
  asked = [];
  reached = [];
  measured = [];
  useDebug.setState({ probing: false, pendingSpawn: null });
  useMatch.getState().clear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  useLobby.setState({
    setDebugField: (kind, boat) => asked.push({ kind, boat }),
    setDebugReach: (enabled: boolean) => reached.push(enabled),
    setDebugStats: (enabled: boolean) => measured.push(enabled),
  } as Partial<ReturnType<typeof useLobby.getState>> as never);
});

describe('seg.field', () => {
  it('lists the fields when asked for nothing', () => {
    seg().field();
    expect(asked).toEqual([]);
    expect(console.log).toHaveBeenCalled();
  });

  it('refuses a field that does not exist, naming the ones that do', () => {
    seatDebugMatch();
    seg().field('temperature' as never);

    expect(asked).toEqual([]);
    expect(vi.mocked(console.error).mock.calls[0]?.[0]).toContain(FIELD_KINDS[0]);
  });

  it('refuses every field on a match nobody turned debug mode on for', () => {
    seatMatch();
    seg().field('noise');
    expect(asked).toEqual([]);
  });

  it('asks for a map-wide field with no boat at all', () => {
    seatDebugMatch();
    seg().field('noise');

    expect(asked).toEqual([{ kind: 'noise', boat: null }]);
  });

  it('sends the picked boat with a field that is about a hydrophone', () => {
    seatDebugMatch();
    useMatch.getState().select(4);
    seg().field('detect');

    expect(asked).toEqual([{ kind: 'detect', boat: 4 }]);
  });

  it('re-asks for the field when the selection moves to another boat', () => {
    // The behaviour the subscription exists for: the boat a developer is asking about is
    // invariably the boat they have just clicked on.
    seatDebugMatch();
    useMatch.getState().select(4);
    seg().field('imaging');
    asked = [];

    useMatch.getState().select(9);

    expect(asked).toEqual([{ kind: 'imaging', boat: 9 }]);
    // And the stale measurement is off the scope while the new one is in flight — an overlay
    // wearing the wrong boat's answer is worse than no overlay.
    expect(useMatch.getState().field).toBeNull();
  });

  it('stops following once the overlay is switched off', () => {
    seatDebugMatch();
    useMatch.getState().select(4);
    seg().field('detect');
    seg().field(null);
    asked = [];

    useMatch.getState().select(9);

    expect(asked).toEqual([]);
  });

  it('stops following when a map-wide field replaces a per-boat one', () => {
    // `noise` has no listener, so a selection change must not send a pointless re-request — and
    // must certainly not send one naming a boat for a field that takes none.
    seatDebugMatch();
    useMatch.getState().select(4);
    seg().field('detect');
    seg().field('noise');
    asked = [];

    useMatch.getState().select(9);

    expect(asked).toEqual([]);
  });

  it('says so rather than failing quietly when nothing is picked', () => {
    seatDebugMatch();
    seg().field('detect');

    expect(asked).toEqual([{ kind: 'detect', boat: null }]);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('seg.noise', () => {
  it('is still the old spelling of the noise field', () => {
    seatDebugMatch();
    seg().noise(true);
    seg().noise(false);

    expect(asked).toEqual([
      { kind: 'noise', boat: null },
      { kind: null, boat: null },
    ]);
  });
});

describe('seg.reach', () => {
  it('refuses a flag that is not one, and every call on a non-debug match', () => {
    seatDebugMatch();
    seg().reach('yes' as never);
    expect(reached).toEqual([]);
    expect(console.error).toHaveBeenCalled();

    useMatch.getState().clear();
    seatMatch();
    seg().reach(true);
    expect(reached).toEqual([]);
  });

  it('switches the rings on and off, and takes the last frame off the scope with it', () => {
    seatDebugMatch();
    seg().reach(true);
    expect(reached).toEqual([true]);

    // A frame lands while they are on, and switching off must not leave it sitting there: rings
    // that have quietly stopped following the fleet are worse than no rings at all.
    useMatch.setState({
      reach: [{ id: 1, team: 'team1', pos: { x: 0, y: 0 }, imaging: 100, heard: 900 }],
    });
    seg().reach(false);

    expect(reached).toEqual([true, false]);
    expect(useMatch.getState().reach).toEqual([]);
  });
});

describe('seg.probe', () => {
  it('refuses a flag that is not one, and every call on a non-debug match', () => {
    seatDebugMatch();
    seg().probe('on' as never);
    expect(useDebug.getState().probing).toBe(false);
    expect(console.error).toHaveBeenCalled();

    useMatch.getState().clear();
    seatMatch();
    seg().probe(true);
    expect(useDebug.getState().probing).toBe(false);
  });

  it('opens and closes the panel without telling the server anything', () => {
    // The only command here that sends nothing: what goes on the wire is one `debug.probe` per
    // ctrl+click, and the server holds no notion of whether the panel is open.
    seatDebugMatch();
    seg().probe(true);
    expect(useDebug.getState().probing).toBe(true);

    seg().probe(false);
    expect(useDebug.getState().probing).toBe(false);
  });

  it('leaves the last reading in place when it closes', () => {
    // A probe is a measurement somebody took. Finding it still there on reopening is what makes
    // the panel a notebook rather than a gauge.
    seatDebugMatch();
    seg().probe(true);
    useMatch.setState({
      probe: {
        at: { x: 10, y: 20 },
        depth: 100,
        water: true,
        cell: 3,
        noise: 12,
        background: 9,
        listener: null,
      },
    });

    seg().probe(false);

    expect(useMatch.getState().probe).not.toBeNull();
  });
});

describe('seg.stats', () => {
  it('refuses a flag that is not one, and every call on a non-debug match', () => {
    seatDebugMatch();
    seg().stats('yes' as never);
    expect(measured).toEqual([]);
    expect(console.error).toHaveBeenCalled();

    useMatch.getState().clear();
    seatMatch();
    seg().stats(true);
    expect(measured).toEqual([]);
  });

  it('switches the panel on, and takes its numbers away when it goes off', () => {
    // Unlike a probe reading, which is a measurement somebody took: this is a live gauge, and
    // numbers left sitting there would be a claim about a server that has moved on.
    seatDebugMatch();
    seg().stats(true);
    useMatch.setState({
      stats: {
        tick: 40,
        window: 40,
        budgetMs: 50,
        phases: [],
        counts: {
          boats: 2,
          torpedoes: 0,
          zones: 0,
          entities: 2,
          sources: 2,
          listeners: 2,
          fieldCells: 10,
          clippedFields: 0,
          visionCells: 4,
          latticeCells: 100,
          waterCells: 90,
        },
      },
    });

    seg().stats(false);

    expect(measured).toEqual([true, false]);
    expect(useMatch.getState().stats).toBeNull();
  });
});
