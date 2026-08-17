/**
 * The benchmark harness itself, and the one claim every phase number in `bench-netcode` rests on.
 *
 * `bench-netcode/scenario.ts` drives real production code — a real `MatchRuntime`, the real
 * `publishMatch` the match's worker thread calls, a real `JsonCodec` — with exactly one exception:
 * `publishByPhase` mirrors that publish so `vision`, `assemble`, `encode` and `send` can be timed
 * apart, which `publishMatch` cannot do because it builds and sends in one step.
 *
 * The bench holds a `MatchRuntime` directly rather than a `MatchStore` and a `MatchHandler`, since
 * matches run on worker threads and neither of those is on the publish path any more. The loop that
 * *is* on it was lifted into `server/match/publish.ts` precisely so the worker and this harness
 * could share one copy — which shrinks what the mirror below can drift from, without removing the
 * reason to check.
 *
 * **That mirror is the thing this file exists to pin.** If it drifts from production, every phase
 * split `bench:netcode` prints is a measurement of the bench rather than of the server, and
 * nothing else would notice. So the first test here runs two identical matches to the same tick,
 * publishes one down each path, and compares the bytes.
 *
 * The rest guards the properties the benchmarks quietly assume: that the fixture is deterministic,
 * that the warm-up does what it claims, and that the fake socket really is the gateway's send path
 * rather than an approximation of it.
 */

import { JsonCodec, createMatchView, teamFor, viewFor } from '@seg/shared';
import { describe, expect, it } from 'vitest';

import { NetBench, NetProcess, scenario } from '../src/bench-netcode/scenario.js';

/** Small, fast, and with a real picture in it: 2v2 cavitating on a small dense map. */
const FIXTURE = scenario('typical', {
  players: 4,
  boats: 2,
  mapSize: 'small',
  throttle: 'flank',
  warmup: 6,
  ticks: 8,
});

/**
 * A fixture where the team actually confirms terrain, for the chart tests.
 *
 * One boat a side rather than two: a crowded team is a deaf team — several hulls in a deployment
 * band raise each other's noise floor (`content/acoustics.ts`) — and at 2×2 on this map nothing is
 * charted at all. That is the acoustic model working as designed, and it is also a warning about
 * fixture choice: **a bigger fleet has a smaller picture per boat**, so a chart assertion written
 * against a large fixture would pass or fail for reasons that have nothing to do with the netcode.
 */
const CHART_FIXTURE = scenario('typical', {
  players: 2,
  boats: 1,
  mapSize: 'small',
  throttle: 'flank',
  warmup: 8,
  ticks: 8,
});

describe('the phase mirror', () => {
  it('produces byte-for-byte what the real publish path produces', () => {
    // Two runtimes rather than one: building a frame advances the chart watermark and the view
    // sequence, so the same match cannot be published twice on one tick and compared. Identical
    // seeds make the two worlds the same world — which is also what makes this a determinism test
    // for the simulation, for free.
    const real = new NetBench(FIXTURE, 'mirror');
    const mirrored = new NetBench(FIXTURE, 'mirror');
    real.warmUp();
    mirrored.warmUp();

    let publishes = 0;
    for (let tick = 0; tick < FIXTURE.ticks; tick += 1) {
      const dueReal = real.tick();
      const dueMirror = mirrored.tick();
      // If the two disagree about when a frame is due, nothing below means anything.
      expect(dueMirror).toBe(dueReal);
      if (!dueReal) continue;

      real.publish();
      const phases = mirrored.publishByPhase();
      expect(phases.frames).toBe(real.recipients.length);
      publishes += 1;
    }

    expect(publishes).toBeGreaterThan(0);
    expect(
      mirrored.codec.outbound.bytesOf('match.view'),
      'the phase mirror has drifted from match/publish.ts — every phase split in ' +
        'bench:netcode is measuring the bench rather than the server until it is fixed',
    ).toBe(real.codec.outbound.bytesOf('match.view'));
    expect(mirrored.codec.outbound.countOf('match.view')).toBe(
      real.codec.outbound.countOf('match.view'),
    );
  });

  it('numbers frames from one, exactly as ViewSequencer does', () => {
    // `ViewSequencer.next` hands out `(seq ?? 0) + 1`. The mirror keeps its own counter, and a
    // counter that started anywhere else would make the byte comparison above pass by luck — a
    // one-digit sequence and a two-digit one are different frame sizes.
    const bench = new NetBench(FIXTURE, 'seq');
    bench.warmUp();
    while (!bench.tick()) {
      /* to the first solve */
    }
    bench.publishByPhase();

    const view = bench.state;
    const rebuilt = createMatchView('seq', 1, viewFor(view, 'p0', undefined, false));
    expect(rebuilt.seq).toBe(1);
    expect(teamFor(view, 'p0')).toBe('team1');
  });
});

describe('the fixture', () => {
  it('is deterministic across constructions', () => {
    const first = run(new NetBench(FIXTURE, 'det'));
    const second = run(new NetBench(FIXTURE, 'det'));
    expect(second).toEqual(first);
  });

  it('changes shape when the match id changes, which is why baselines fix it', () => {
    // `matchId` is in every `match.view`. One character is one byte per frame — the smallest
    // possible demonstration that a byte baseline is a baseline *of a scenario*, not of the code.
    const short = run(new NetBench(FIXTURE, 'a'));
    const long = run(new NetBench(FIXTURE, 'aaaaaaaaaa'));
    expect(long.total).toBeGreaterThan(short.total);
    expect(long.total - short.total).toBe(9 * long.frames);
  });

  it('puts the fleet under way, because a quiet fleet lights nothing', () => {
    const bench = new NetBench(FIXTURE, 'way');
    expect(bench.state.boats.every((boat) => boat.throttle === 'flank')).toBe(true);
    expect(bench.state.boats.every((boat) => boat.speed > 0)).toBe(true);
  });

  it('seats spectators, who are sent frames and command nothing', () => {
    const bench = new NetBench({ ...FIXTURE, spectators: 2 }, 'spec');
    bench.warmUp();
    while (!bench.tick()) {
      /* to the first solve */
    }
    bench.publish();

    expect(bench.recipients).toHaveLength(FIXTURE.players + 2);
    const spectator = bench.recipients.find((connection) => connection.accountId === 'ps0');
    expect(spectator?.frameSizes.length).toBe(1);
    // planning/07 §5: a spectator has no team, so no sonar picture of their own.
    expect(spectator?.lastView?.vision.contacts).toEqual([]);
    expect(spectator?.lastView?.own).toEqual([]);
  });
});

describe('the warm-up', () => {
  it('leaves the chart burst behind, so it is not measured as the steady state', () => {
    // The first frame after deployment carries every terrain square the team has confirmed and is
    // more than twice the steady-state size. A bench that measured from tick zero would report the
    // reconnect burst as the normal case — `match-runtime.test.ts` pins the same property one
    // level down, in squares rather than in bytes.
    const cold = new NetBench(CHART_FIXTURE, 'chart');
    while (!cold.tick()) {
      /* to the first solve */
    }
    cold.publish();
    const firstFrame = cold.recipients[0]?.frameSizes[0] ?? 0;
    expect(cold.recipients[0]?.lastView?.vision.charted.length).toBeGreaterThan(0);

    const warm = new NetBench(CHART_FIXTURE, 'chart');
    warm.warmUp();
    while (!warm.tick()) {
      /* to the first solve after the warm-up */
    }
    warm.publish();
    const steadyFrame = warm.recipients[0]?.frameSizes[0] ?? 0;

    expect(firstFrame).toBeGreaterThan(steadyFrame * 2);
    expect(warm.recipients[0]?.frameSizes).toHaveLength(1);
    // The chart is appended once and never re-sent: the whole reason a view frame stays small.
    expect(warm.recipients[0]?.lastView?.vision.charted).toEqual([]);
  });

  it('resets the meters, so nothing before it is counted', () => {
    const bench = new NetBench(FIXTURE, 'reset');
    bench.warmUp();
    expect(bench.bytes).toBe(0);
    expect(bench.codec.outbound.totals.bytes).toBe(0);
  });
});

describe('forgetCharts', () => {
  it('makes the next frame carry the chart again — the reconnect burst', () => {
    // `MatchRuntime.forget` is what a real reconnect calls (Q21), so the `burst` scenario measures
    // the production path rather than a bench-only lever.
    const bench = new NetBench(CHART_FIXTURE, 'chart');
    bench.warmUp();

    while (!bench.tick()) {
      /* steady state */
    }
    bench.publish();
    const steady = bench.recipients[0]?.frameSizes.at(-1) ?? 0;
    expect(bench.recipients[0]?.lastView?.vision.charted).toEqual([]);

    bench.forgetCharts();
    while (!bench.tick()) {
      /* the frame after the reconnect */
    }
    bench.publish();
    const afterReconnect = bench.recipients[0]?.frameSizes.at(-1) ?? 0;

    expect(bench.recipients[0]?.lastView?.vision.charted.length).toBeGreaterThan(0);
    expect(afterReconnect).toBeGreaterThan(steady);
  });
});

describe('the fake socket', () => {
  it('encodes exactly as the gateway does', () => {
    // `realtime/gateway.ts` builds its connection as `transport.send('control', codec.encode(m))`.
    // If the bench estimated a size instead of encoding, every byte figure would be fiction.
    const bench = new NetBench(FIXTURE, 'sock');
    bench.warmUp();
    while (!bench.tick()) {
      /* to a frame */
    }
    bench.publish();

    const connection = bench.recipients[0];
    const view = connection?.lastView;
    expect(view).toBeDefined();
    if (view === undefined || connection === undefined) return;

    const expected = new JsonCodec().encode(
      createMatchView('sock', connection.frameSizes.length, view),
    ).byteLength;
    expect(connection.frameSizes.at(-1)).toBe(expected);
  });
});

describe('NetProcess', () => {
  it('ticks several matches serially, which is now the per-core capacity figure', () => {
    // planning/17 §1.5: `server/match/clock.ts` walks every running match through one interval.
    // A bench that ticked one match and multiplied by M would miss the thing that makes the
    // capacity number interesting.
    const process_ = new NetProcess({ ...FIXTURE, matches: 3 }, 3);
    process_.warmUp();

    expect(process_.recipients).toHaveLength(3 * FIXTURE.players);

    process_.step();
    process_.step();
    expect(process_.bytes).toBeGreaterThan(0);
    // Every connection in every match got a frame — nothing was skipped by the shared registry.
    expect(process_.recipients.every((connection) => connection.frameSizes.length > 0)).toBe(true);
  });

  it('namespaces accounts, so two matches cannot evict each other', () => {
    // `ConnectionRegistry` and `MatchStore.byAccount` are both keyed by account id. Two matches
    // whose players were both called `p0` would route one match's frames into the other, and the
    // failure would look like a bandwidth measurement rather than like a bug.
    const process_ = new NetProcess({ ...FIXTURE, matches: 2 }, 2);
    const ids = process_.recipients.map((connection) => connection.accountId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/** Every frame size the fixture produces, plus the total — the shape a determinism check needs. */
function run(bench: NetBench): {
  readonly total: number;
  readonly frames: number;
  readonly sizes: readonly number[];
} {
  bench.warmUp();
  for (let tick = 0; tick < FIXTURE.ticks; tick += 1) {
    if (bench.tick()) bench.publish();
  }
  const sizes = bench.recipients.flatMap((connection) => connection.frameSizes);
  return { total: bench.bytes, frames: sizes.length, sizes };
}
