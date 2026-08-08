/**
 * A running match, built the way the server builds one.
 *
 * `deployMatch` and `setupFor`/`viewFor` rather than hand-written literals, deliberately: a
 * fixture that invented its own `MatchSetup` would keep passing after the projection changed
 * shape, and the projection is the thing most of these tests are really about.
 */

import {
  deployMatch,
  generateMap,
  setupFor,
  viewFor,
  type ChatEntry,
  type BoatTemplate,
  type DeployingPlayer,
  type GeneratedMap,
  type MatchSetup,
  type MatchState,
  type MatchViewState,
} from '@seg/shared';

import { useMatch } from '../src/state/match.js';

export const YOU = 'a1';
export const MATE = 'a2';
export const FOE = 'a3';

const BOATS: readonly BoatTemplate[] = [
  { name: 'S-01', hull: 'light', modules: [] },
  { name: 'S-02', hull: 'heavy', modules: [] },
];

export interface FixtureOptions {
  readonly matchId?: string;
  readonly mode?: MatchState['mode'];
  readonly map?: GeneratedMap;
  /** Who the fixture is projected for. Pass `FOE` for the other side, or a spectator's id. */
  readonly as?: string;
  readonly players?: readonly DeployingPlayer[];
}

export function matchState(options: FixtureOptions = {}): MatchState {
  return deployMatch({
    matchId: options.matchId ?? 'm1',
    mode: options.mode ?? 'objective-capture',
    map: options.map ?? generateMap('empty', { seed: 42, mapSize: 'medium' }),
    startedAt: 1_700_000_000_000,
    players: options.players ?? [
      { accountId: YOU, username: 'Skipper', position: 'team1', boats: BOATS },
      { accountId: MATE, username: 'Bosun', position: 'team1', boats: [BOATS[0]!] },
      { accountId: FOE, username: 'Rival', position: 'team2', boats: BOATS },
    ],
  });
}

/** The pair of payloads one account is sent. */
export function matchFixture(options: FixtureOptions = {}): {
  readonly state: MatchState;
  readonly setup: MatchSetup;
  readonly view: MatchViewState;
} {
  const state = matchState(options);
  const account = options.as ?? YOU;
  return { state, setup: setupFor(state, account), view: viewFor(state, account) };
}

/**
 * jsdom has no 2D canvas, and the mini-map asks for one.
 *
 * Stubbed to `null` rather than left alone: unstubbed, jsdom writes a "not implemented"
 * error to the console for every render, which buries anything a failing test has to say.
 * The component already treats a missing context as "draw nothing", so this exercises the
 * same path a browser without canvas would take.
 */
export function stubCanvas(): void {
  HTMLCanvasElement.prototype.getContext = () => null;
}

/**
 * jsdom does not implement `<dialog>`, and the Esc menu relies on `showModal` to reach the top
 * layer. Enough of one to open, close, and fire `close` — which is all the menu asks of it.
 */
export function stubDialog(): void {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}

/** Seat the store as if `match.state` and the first `match.view` had both landed. */
export function seatMatch(
  options: FixtureOptions & { readonly chat?: readonly ChatEntry[] } = {},
): ReturnType<typeof matchFixture> {
  const fixture = matchFixture(options);
  const { matchId } = fixture.setup;
  useMatch.setState({
    matchId,
    setups: { [matchId]: fixture.setup },
    views: { [matchId]: fixture.view },
    seqs: { [matchId]: 1 },
    chat: options.chat ?? [],
    chatRejection: null,
  });
  return fixture;
}
