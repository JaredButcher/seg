/**
 * What a returning player is owed, and the property that says they got it.
 *
 * [planning/13 §10](../../../planning/13-testing.md) asks for this in one line — "a client drops
 * mid-match, reconnects within the window, and its restored view matches what a
 * continuously-connected client would have" — and nothing was checking it.
 *
 * ## Why it matters more than it looks
 *
 * A view frame is a *delta over what this connection already knows* in one place already: the
 * chart. `VisionFrame.charted` carries terrain squares once and never again, against a watermark
 * held per account (`MatchRuntime.chartSeen`). That is the pattern any future trimming will reach
 * for — planning/17 §5.4 lists `order`, the zone geometry and the tube inventory as the next
 * candidates — and every one of them turns "this connection has been told" into state the server
 * has to remember and, crucially, **has to forget at exactly the right moment**.
 *
 * Forgetting too little is the dangerous direction: the player reconnects, the server thinks it
 * already told them where their boats are going, and it never says again. Nothing throws. The HUD
 * is simply wrong for the rest of the match.
 *
 * So this file asserts the *invariant* rather than the mechanism: **a reconnecting client, given
 * the setup and one frame, knows everything a client that never left knows.** It is written to
 * survive the trimming, and to fail the moment a trim forgets a reset.
 *
 * ## How the comparison is made
 *
 * The **same account, across two runs of the same match** — one where it never drops, one where it
 * does — rather than two accounts on one team. The simulation is deterministic, so the two runs are
 * the same world tick for tick, and the comparison is like for like.
 *
 * The first draft did use two accounts on a team, and it could not work: **a crowded team is a deaf
 * team.** Three medium hulls in a deployment band raise each other's noise floor enough that the
 * team confirms *no* terrain at all, so the chart — the one field this file most needs to exercise —
 * was empty on both sides and the assertion passed by comparing nothing to nothing. A 1v1 fixture
 * charts 314 squares. That is `content/acoustics.ts` working as designed and it is recorded in
 * planning/17 §2.2; it is also a standing warning about fixtures that assert on an empty set.
 *
 * Knowledge is *accumulated*: the chart is appended across frames and cleared whenever a fresh
 * `match.state` arrives, because that is what a new tab does.
 */

import {
  deployMatch,
  generateMap,
  throttleSpeedFor,
  unpackCells,
  type BoatTemplate,
  type DeployingPlayer,
  type MatchSetup,
  type MatchState,
  type MatchViewState,
  type ServerMessage,
} from '@seg/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { MatchHandler } from '../src/match/handler.js';
import { MatchStore } from '../src/match/store.js';
import { ConnectionRegistry, type PlayerConnection } from '../src/realtime/connections.js';

const BOAT: BoatTemplate = { name: 'S-01', hull: 'medium', modules: [] };

function seat(accountId: string, position: DeployingPlayer['position']): DeployingPlayer {
  return { accountId, username: accountId, position, boats: [BOAT] };
}

/**
 * A dense map and a fleet under way.
 *
 * Three things matter, and the third is the one that cost a debugging session.
 *
 * On open water there is no terrain to chart, so the one place the wire is *already* incremental
 * would never be exercised. A boat at its berth on a `hold` order does not move, which is the
 * mistake planning/17 §5.3 records the benchmarks making. And the fleet is **one boat a side**,
 * because a crowded team is a deaf team — four medium hulls in a deployment band raise each other's
 * noise floor enough to chart nothing at all (`content/acoustics.ts`, and planning/17 §2.2 records
 * measuring it). A fixture with two boats each would assert on an empty chart and pass forever.
 */
function match(): MatchState {
  const state = deployMatch({
    matchId: 'm1',
    mode: 'objective-capture',
    map: generateMap('dense', { seed: 11, mapSize: 'small' }),
    startedAt: 0,
    players: [seat('leaver', 'team1'), seat('foe', 'team2')],
  });
  return {
    ...state,
    boats: state.boats.map((boat) => ({
      ...boat,
      throttle: 'flank' as const,
      speed: throttleSpeedFor(boat.stats, 'flank'),
    })),
  };
}

interface Fake extends PlayerConnection {
  readonly sent: ServerMessage[];
}

function fake(accountId: string): Fake {
  const sent: ServerMessage[] = [];
  return { accountId, username: accountId, sent, send: (message) => sent.push(message) };
}

/** Everything one connection can be said to know, accumulated over every message it received. */
interface Knowledge {
  /** Terrain squares, unioned across every frame — the one field that is already incremental. */
  readonly chart: Set<number>;
  /** The chart watermark the server last reported. */
  readonly chartSeen: number;
  /** The most recent full frame. */
  readonly view: MatchViewState;
  readonly setup: MatchSetup;
}

function knowledgeOf(connection: Fake): Knowledge {
  const chart = new Set<number>();
  let view: MatchViewState | undefined;
  let setup: MatchSetup | undefined;
  let chartSeen = 0;

  for (const message of connection.sent) {
    if (message.t === 'match.state') {
      setup = message.setup;
      // A fresh setup is a fresh client: whatever it had charted, this tab does not have it. That
      // is what `MatchHandler.attach` promises by resetting the watermark, and modelling it here
      // is what makes the comparison honest rather than accidentally passing on stale data.
      chart.clear();
      chartSeen = 0;
    }
    if (message.t === 'match.view') {
      view = message.view;
      // `charted` is a **gap-delta run**, not a list of ids (`match/vision.ts#packCells`): the
      // first entry is absolute and the rest are differences. Unioning the raw numbers looks like
      // it works and quietly counts every repeated gap as a repeated square — which is what the
      // first draft of this file did, and it reported 265 duplicates on a connection that had
      // never dropped.
      for (const cell of unpackCells(message.view.vision.charted)) chart.add(cell);
      chartSeen = message.view.vision.chartSeen;
    }
  }

  if (view === undefined || setup === undefined) throw new Error('connection was told nothing');
  return { chart, chartSeen, view, setup };
}

/** Total sim ticks every run is driven for, so two runs end on the same tick. */
const TICKS = 60;
/** When the socket dies, and when the new tab appears. */
const DROP_AT = 12;
const RETURN_AT = 24;

interface Run {
  readonly leaver: Fake;
  readonly foe: Fake;
  readonly store: MatchStore;
}

/**
 * Play one match through, optionally dropping `leaver` for the middle stretch.
 *
 * `dropped: false` is the control. Both runs tick the same number of times against the same seed,
 * so anything that differs between them differs because of the disconnect and nothing else.
 */
function play(dropped: boolean): Run {
  const store = new MatchStore();
  const connections = new ConnectionRegistry();
  const handler = new MatchHandler({ store, connections, clock: () => 0 });

  const leaver = fake('leaver');
  const foe = fake('foe');
  for (const connection of [leaver, foe]) connections.add(connection);

  store.store(match(), 'Test Lobby');
  handler.begin('m1');

  for (let tick = 0; tick < TICKS; tick += 1) {
    if (dropped && tick === DROP_AT) {
      // The socket dies. The seat is held and the boats keep their standing orders
      // (planning/01 §7) — nothing here removes the player from the match.
      connections.remove(leaver);
      handler.detach('leaver');
    }
    if (dropped && tick === RETURN_AT) {
      // A new tab. `attach` deliberately **offers** rather than resumes: a seat that is not
      // marked connected gets `match.rejoinable`, because dropping a player straight back into a
      // HUD they walked away from is an ambush rather than a resume (`MatchHandler.attach`). The
      // client's button then sends `match.rejoin`.
      connections.add(leaver);
      handler.attach(leaver);
      handler.rejoin(leaver);
    }
    const runtime = store.runtime('m1');
    if (runtime?.tick() === true) handler.publish('m1');
  }

  return { leaver, foe, store };
}

let dropped: Run;
let continuous: Run;

beforeEach(() => {
  dropped = play(true);
  continuous = play(false);
});

describe('a player who drops and comes back', () => {
  it('is charted everything its team charted while it was away', () => {
    // The invariant that would break first if a watermark were reset in the wrong place: the chart
    // is the one field already sent once and never again, so a client that missed the frames
    // carrying it has no way to ask for them.
    const away = knowledgeOf(dropped.leaver);
    const present = knowledgeOf(continuous.leaver);

    expect(present.chart.size).toBeGreaterThan(0);
    expect([...away.chart].sort((a, b) => a - b)).toEqual([...present.chart].sort((a, b) => a - b));
    expect(away.chartSeen).toBe(present.chartSeen);
  });

  it('sees the same world as the run where it never dropped, field for field', () => {
    // The whole property, stated once (planning/13 §10). Same account, same seed, same tick — so
    // every field of the last frame must agree, and any that does not is something the reconnect
    // failed to restore.
    const away = knowledgeOf(dropped.leaver).view;
    const present = knowledgeOf(continuous.leaver).view;

    expect(away.phase).toBe(present.phase);
    expect(away.clock).toEqual(present.clock);
    expect(away.teams).toEqual(present.teams);
    expect(away.zones).toEqual(present.zones);
    expect(away.boats).toEqual(present.boats);
    expect(away.wrecks).toEqual(present.wrecks);
    expect(away.torpedoes).toEqual(present.torpedoes);
    expect(away.own).toEqual(present.own);
    expect(away.vision).toEqual(present.vision);
  });

  it('knows what is in its own tubes', () => {
    // `own` is restated in full every frame today, so this passes trivially. planning/17 §5.4
    // proposes trimming it to send-on-change; **this is the assertion that would catch a trim
    // which forgot that a reconnecting client has been told nothing.**
    const away = knowledgeOf(dropped.leaver).view;

    expect(away.own).toHaveLength(1);
    for (const own of away.own) {
      expect(own.tubes.length).toBeGreaterThan(0);
      expect(own.countermeasure.status).toBeDefined();
    }
  });

  it('is offered a rejoin rather than being dropped back into the HUD', () => {
    // `attach` on a seat marked disconnected offers; it does not resume. The distinction is a
    // product decision (Q21) and it is the reason `rejoin` exists as a separate entry point.
    expect(dropped.leaver.sent.some((m) => m.t === 'match.rejoinable')).toBe(true);
    expect(continuous.leaver.sent.some((m) => m.t === 'match.rejoinable')).toBe(false);
  });

  it('is handed the setup again, because a new tab has none', () => {
    // Everything static lives here (planning/02 §6's whole bandwidth argument), so this message is
    // what makes moving *more* static data out of the view frame safe. If it ever stopped being
    // resent, every such trim would become a silent bug on reconnect.
    const setups = dropped.leaver.sent.filter((m) => m.t === 'match.state');
    expect(setups.length).toBe(2);
    expect(continuous.leaver.sent.filter((m) => m.t === 'match.state')).toHaveLength(1);

    const away = knowledgeOf(dropped.leaver);
    // The *team's* fleet, not this player's: an ally's stat block is theirs to read
    // (`view.ts#BoatProfile`). One player a side here, so one boat.
    expect(away.setup.fleet).toHaveLength(1);
    expect(away.setup.map.extents.width).toBeGreaterThan(0);
    expect(away.setup.you.team).toBe('team1');
  });

  it('receives its first frame after the setup, never before it', () => {
    // Ordering, on the one channel where it is currently guaranteed. A frame that arrived first
    // would be a frame the client cannot interpret — it has no fleet to attach it to — and
    // planning/02 §3.3 says this stops being free the moment a second transport exists.
    const kinds = dropped.leaver.sent.map((m) => m.t);
    const lastSetup = kinds.lastIndexOf('match.state');
    expect(lastSetup).toBeGreaterThan(0);
    expect(kinds.slice(lastSetup).filter((k) => k === 'match.view').length).toBeGreaterThan(0);
  });

  it('is sent nothing at all while it is away', () => {
    // The seat is held, not served. A frame queued for a socket that is not there is work done for
    // nobody, and `MatchHandler.publish` skips on `connected` as well as on having a connection.
    const framesWhileAway = dropped.leaver.sent.filter((m) => m.t === 'match.view').length;
    const framesThroughout = continuous.leaver.sent.filter((m) => m.t === 'match.view').length;
    expect(framesWhileAway).toBeLessThan(framesThroughout);
  });
});

describe('a player who never left', () => {
  it('is not re-sent the chart it already has', () => {
    // The other half of the invariant, and the reason the watermark exists at all. If this ever
    // fails, the chart is being re-sent every frame and planning/02 §6's budget is gone.
    const frames = continuous.leaver.sent.filter((m) => m.t === 'match.view');
    expect(frames.length).toBeGreaterThan(2);

    const seen = new Set<number>();
    let repeats = 0;
    for (const frame of frames) {
      if (frame.t !== 'match.view') continue;
      for (const cell of unpackCells(frame.view.vision.charted)) {
        if (seen.has(cell)) repeats += 1;
        seen.add(cell);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    expect(repeats).toBe(0);
  });

  it('keeps a monotonic view sequence across its own reconnect', () => {
    // A reconnect resets the *chart* watermark and nothing else. The sequence has to keep climbing
    // — planning/02 §3.4's baseline-ack scheme, when it arrives, names an absolute sequence, and a
    // counter that restarted would make two different frames share a number.
    const seqs = dropped.leaver.sent.flatMap((m) => (m.t === 'match.view' ? [m.seq] : []));
    expect(seqs.length).toBeGreaterThan(2);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('the enemy', () => {
  it('learns nothing from a reconnect on the other side', () => {
    // Authority, checked at the seam a reconnect opens: `attach` rebuilds one connection's view and
    // must not touch anybody else's (planning/01 §5 rule 2). The other side's stream is
    // byte-for-byte what it would have been.
    const disturbed = dropped.foe.sent.filter((m) => m.t === 'match.view');
    const undisturbed = continuous.foe.sent.filter((m) => m.t === 'match.view');

    expect(dropped.foe.sent.filter((m) => m.t === 'match.state')).toHaveLength(1);
    expect(disturbed).toHaveLength(undisturbed.length);
    expect(disturbed).toEqual(undisturbed);
  });
});
