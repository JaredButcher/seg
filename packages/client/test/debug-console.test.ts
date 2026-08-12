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

import { useLobby } from '../src/state/lobby.js';
import { useMatch } from '../src/state/match.js';
import { seatMatch } from './match-fixture.js';

import '../src/debug/console.js';

/** What the console actually asked the server for, in order. */
let asked: { kind: string | null; boat: number | null }[];

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
  useMatch.getState().clear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  useLobby.setState({
    setDebugField: (kind, boat) => asked.push({ kind, boat }),
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
