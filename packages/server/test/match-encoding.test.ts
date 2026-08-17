/**
 * Every frame a real match produces, through the real encoder.
 *
 * ## Why this file exists
 *
 * `protocol-binary.test.ts` tests the codec thoroughly — quantization, truncation, hostile buffers,
 * schema stability — but it tests it against a **hand-written fixture**, and a hand-written fixture
 * has the values a person thought to write down. Its torpedo faces 45°, its boats sit at sensible
 * coordinates, and every number in it is comfortably inside the range its field declares.
 *
 * The simulation is not obliged to agree. A `facing` of `-90` was written straight into a
 * noisemaker at construction and never normalized, because a noisemaker is the one thing in the
 * water that never steers and so never passes through `normalizeDeg` (`sim/weapons/launch.ts`).
 * `-90 / 0.01` is `-9000`, the field is a `u16`, and the encoder threw on the first publish after a
 * player pressed the drop key — taking that match's tick with it. Nothing in the suite could have
 * caught it: the codec tests never saw a noisemaker, and the noisemaker tests never saw the codec.
 *
 * So this is the join. It runs a match with things actually happening in it and encodes every frame
 * with **both** codecs, asserting only that the encoder does not throw and the frame comes back.
 * It makes no claim about the values — the files above own that — and it deliberately asserts
 * almost nothing, because the failure it exists to catch is an exception rather than a wrong number.
 *
 * ## Where the fix belongs, when this fails
 *
 * **In the simulation, not here.** The codec's range check is not an inconvenience to be worked
 * around with a clamp before encoding — it is the thing that turned a silently-wrapped coordinate
 * into a loud failure (`protocol/binary/walk.ts#RANGES`). Sanitizing on the way out would convert
 * every future bug of this class from an exception into a boat that teleports. If this test fails,
 * something upstream is producing a value it promised not to.
 */

import {
  BinaryCodec,
  JsonCodec,
  deployMatch,
  generateMap,
  type BoatTemplate,
  type Codec,
  type DeployingPlayer,
  type MatchState,
  type MatchViewMessage,
  type ServerMessage,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

import { publishMatch, ViewSequencer } from '../src/match/publish.js';
import { MatchRuntime } from '../src/match/runtime.js';

const TICK_HZ = 20;

const BOAT: BoatTemplate = { name: 'S-01', hull: 'medium', modules: [] };

function seat(accountId: string, position: DeployingPlayer['position']): DeployingPlayer {
  return { accountId, username: accountId, position, boats: [BOAT] };
}

/** Two boats a long way apart, under way, on a map with rock in it. */
function match(): MatchState {
  return deployMatch({
    matchId: 'enc-1',
    mode: 'objective-capture',
    map: generateMap('dense', { seed: 11, mapSize: 'small' }),
    startedAt: 0,
    debugMode: true,
    players: [seat('host', 'team1'), seat('foe', 'team2'), seat('watcher', 'spectator')],
  });
}

const codecs: Readonly<Record<string, Codec>> = {
  binary: new BinaryCodec(),
  json: new JsonCodec(),
};

/**
 * Run a match, encoding every message every recipient is sent.
 *
 * Returns the frames so a test can confirm it actually exercised something — a run that published
 * nothing would pass every assertion below while proving nothing at all, which is the failure mode
 * this whole file is written against.
 */
function run(
  runtime: MatchRuntime,
  ticks: number,
  onTick?: (tick: number) => void,
): { readonly encoded: number; readonly frames: number } {
  const seqs = new ViewSequencer();
  let encoded = 0;
  let frames = 0;

  for (let i = 0; i < ticks; i += 1) {
    onTick?.(runtime.state.clock.tick);
    if (!runtime.tick()) continue;
    publishMatch(runtime, seqs, (_accountId, message) => {
      for (const codec of Object.values(codecs)) {
        // The assertion is that this line does not throw. `BinaryCodec` range-checks every
        // fixed-width field on the way out (`walk.ts#writeInt`), so a simulation value outside what
        // its field declared fails here and nowhere else.
        const bytes = codec.encode(message);
        const back = codec.decode(bytes) as ServerMessage;
        expect(back.t).toBe(message.t);
        encoded += 1;
      }
      if (message.t === 'match.view') frames += 1;
    });
  }

  return { encoded, frames };
}

/** The boat an account commands. */
function boatOf(runtime: MatchRuntime, accountId: string): number {
  const boat = runtime.state.boats.find((candidate) => candidate.owner === accountId);
  if (boat === undefined) throw new Error(`no boat for ${accountId}`);
  return boat.id;
}

describe('a match through the binary codec', () => {
  it('encodes every frame of a quiet match', () => {
    const runtime = new MatchRuntime(match(), { cellSize: 60, collisionCell: 60 });
    const { encoded, frames } = run(runtime, 20);

    expect(frames).toBeGreaterThan(0);
    expect(encoded).toBeGreaterThan(0);
  });

  /*
   * The regression. `weapons-noisemaker.test.ts` pins the heading itself; this pins the thing that
   * actually broke, which is that a dropped noisemaker reaches the wire at all.
   */
  it('encodes every frame after a noisemaker is dropped', () => {
    const runtime = new MatchRuntime(match(), { cellSize: 60, collisionCell: 60 });
    const mine = boatOf(runtime, 'host');

    let dropped = false;
    const { frames } = run(runtime, 40, () => {
      if (dropped) return;
      dropped = runtime.drop('host', mine);
    });

    // The drop has to have happened, or this test is the quiet one above wearing a different name.
    expect(dropped).toBe(true);
    expect(runtime.state.torpedoes.some((weapon) => weapon.weapon === 'noisemaker')).toBe(true);
    expect(frames).toBeGreaterThan(0);
  });

  it('encodes every frame with weapons in the water and sonar lit', () => {
    // The rest of what a frame can carry: a torpedo under way with an aim point, an active pulse
    // and its `lastPingTick`, and the transients both of those ring on the hulls.
    const runtime = new MatchRuntime(match(), { cellSize: 60, collisionCell: 60 });
    const mine = boatOf(runtime, 'host');
    const theirs = runtime.state.boats.find((boat) => boat.team === 'team2');
    if (theirs === undefined) throw new Error('no target');

    runtime.setActiveSonar('host', mine, true);
    expect(runtime.fire('host', mine, [], theirs.pos)).toBeGreaterThan(0);

    const { frames } = run(runtime, 3 * TICK_HZ);

    expect(frames).toBeGreaterThan(0);
  });

  it('encodes the debug payloads, which carry the widest numbers in the protocol', () => {
    // The overlays are the largest and least-constrained thing on the wire — a packed field map, the
    // ping-reach rings, and the statistics panel — and they are only built for somebody who asked.
    const runtime = new MatchRuntime(match(), { cellSize: 60, collisionCell: 60 });
    const mine = boatOf(runtime, 'host');

    runtime.setActiveSonar('host', mine, true);
    runtime.setDebugField('host', 'noise', null);
    runtime.setDebugReach('host', true);
    runtime.setDebugStats('host', true);
    runtime.drop('host', mine);

    const { encoded } = run(runtime, 4 * TICK_HZ);

    expect(encoded).toBeGreaterThan(0);
  });

  it('re-encodes a decoded frame to the same bytes, on real simulation output', () => {
    // `protocol-binary.test.ts` asserts idempotence against its fixture. This asserts it against
    // numbers the simulation chose, which is where quantization actually gets exercised: a position
    // that does not sit on the half-metre grid has to survive the round trip to land on it.
    const runtime = new MatchRuntime(match(), { cellSize: 60, collisionCell: 60 });
    const mine = boatOf(runtime, 'host');
    runtime.drop('host', mine);

    const seqs = new ViewSequencer();
    const codec = codecs['binary']!;
    let checked = 0;

    for (let i = 0; i < 2 * TICK_HZ; i += 1) {
      if (!runtime.tick()) continue;
      publishMatch(runtime, seqs, (_accountId, message) => {
        if (message.t !== 'match.view') return;
        const once = codec.encode(message);
        const twice = codec.encode(codec.decode(once) as MatchViewMessage);
        expect(Buffer.from(twice)).toEqual(Buffer.from(once));
        checked += 1;
      });
    }

    expect(checked).toBeGreaterThan(0);
  });
});
