/**
 * How publish cost and frame size move with players and with boats — the matrix that answers
 * **Q-17.1** and **Q-17.2** (planning/17 §2).
 *
 * The claim under test: the acoustic solve is computed **per team** and publishing is done **per
 * player**, so holding boats fixed and adding players should leave the solve flat while publish
 * climbs linearly. Nobody had measured where those two lines cross, and the answer decides whether
 * netcode optimization is urgent at all.
 *
 *   pnpm bench:netcode:scaling                  # the default matrix
 *   BOATS_AXIS=1,4,10 PLAYERS_AXIS=2,8,16 pnpm bench:netcode:scaling
 *   TICKS=12 pnpm bench:netcode:scaling         # faster, noisier
 *
 * ## Read the *per-boat* and *per-player-frame* columns, not the totals
 *
 * A total that doubles when the fleet doubles says nothing — of course it does. What the matrix is
 * for is the derivative: if bytes per boat are flat across the players axis, the frame is linear
 * in the fleet and the fix is to make a boat cheaper. If µs per player-frame climbs with player
 * count at fixed boats, something is quadratic and that is a bug rather than a budget.
 *
 * Note it prints **acoustics** and **publish** side by side, off the same tick. That comparison is
 * the whole point and it is not available anywhere else: `bench-acoustics` never builds a frame,
 * so it could not have shown that the two are the same order of magnitude — or that they are not.
 */

import { PERF_SOLVE_PHASES } from '@seg/shared';

import { NetBench, best, kb, optionsFromEnv } from './scenario.js';

const base = optionsFromEnv();

const playersAxis = axis(process.env.PLAYERS_AXIS, [2, 4, 8, 16]);
const boatsAxis = axis(process.env.BOATS_AXIS, [1, 4, 10]);

function axis(raw: string | undefined, fallback: readonly number[]): readonly number[] {
  if (raw === undefined) return fallback;
  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  return parsed.length > 0 ? parsed : fallback;
}

interface Cell {
  readonly players: number;
  readonly boats: number;
  /** Boats in the water — `players × boats`, and the number the solve is linear in. */
  readonly fleet: number;
  /** Minimum ms for one whole publish, across runs. */
  readonly publishMs: number;
  /** Minimum ms for one whole tick including the acoustic solve, across runs. */
  readonly tickMs: number;
  readonly bytesPerFrame: number;
  readonly framesPerPublish: number;
}

const cells: Cell[] = [];

for (const boats of boatsAxis) {
  for (const players of playersAxis) {
    cells.push(measure(players, boats));
  }
}

function measure(players: number, boats: number): Cell {
  const options = { ...base, players, boats };
  const publishSamples: number[] = [];
  const tickSamples: number[] = [];
  let bytesPerFrame = 0;
  let framesPerPublish = 0;

  for (let run = 0; run < options.runs; run += 1) {
    const bench = new NetBench(options, `scale-${players}-${boats}-${run}`);
    // The stopwatch has to be on *before* the ticks that are measured, so the tick figure below
    // is the runtime's own total rather than a wall-clock guess around it.
    bench.runtime.stopwatch.enabled = true;
    bench.warmUp();

    let publishMs = 0;
    let tickMs = 0;
    let publishes = 0;
    for (let tick = 0; tick < options.ticks; tick += 1) {
      const t0 = performance.now();
      const due = bench.tick();
      tickMs += performance.now() - t0;
      if (!due) continue;
      const t1 = performance.now();
      bench.publish();
      publishMs += performance.now() - t1;
      publishes += 1;
    }

    // Per publish, and per *acoustic* tick for the sim side — a solve runs on every second tick,
    // so dividing the tick total by every tick would halve the number that matters.
    publishSamples.push(publishMs / Math.max(1, publishes));
    tickSamples.push(tickMs / Math.max(1, publishes));
    const frames = bench.recipients.reduce((sum, c) => sum + c.frameSizes.length, 0);
    bytesPerFrame = bench.bytes / Math.max(1, frames);
    framesPerPublish = frames / Math.max(1, publishes);
  }

  return {
    players,
    boats,
    fleet: players * boats,
    publishMs: best(publishSamples),
    tickMs: best(tickSamples),
    bytesPerFrame,
    framesPerPublish,
  };
}

// ── Output ────────────────────────────────────────────────────────────────────────────

console.log(
  `map=${base.mapType}/${base.mapSize} seed=${base.seed} hull=${base.hull} ` +
    `throttle=${base.throttle} mode=${base.mode}\n` +
    `  ${base.ticks} ticks, ${base.warmup} warm-up, ${base.runs} runs (minimum reported)\n` +
    `  solve phases measured: ${PERF_SOLVE_PHASES.join(', ')}\n`,
);

console.log(
  `  ${'players'.padStart(7)} ${'boats'.padStart(5)} ${'fleet'.padStart(5)} ` +
    `${'tick+solve'.padStart(10)} ${'publish'.padStart(9)} ${'pub/tick'.padStart(8)} ` +
    `${'µs/frame'.padStart(9)} ${'bytes/frame'.padStart(12)} ${'B/boat'.padStart(7)}`,
);

let lastBoats = -1;
for (const cell of cells) {
  if (cell.boats !== lastBoats) {
    console.log(`  ${'─'.repeat(80)}`);
    lastBoats = cell.boats;
  }
  const ratio = cell.publishMs / Math.max(1e-9, cell.tickMs);
  console.log(
    `  ${String(cell.players).padStart(7)} ${String(cell.boats).padStart(5)} ` +
      `${String(cell.fleet).padStart(5)} ` +
      `${cell.tickMs.toFixed(2).padStart(9)}m ${cell.publishMs.toFixed(2).padStart(8)}m ` +
      `${ratio.toFixed(2).padStart(8)} ` +
      `${((1000 * cell.publishMs) / Math.max(1, cell.framesPerPublish)).toFixed(0).padStart(9)} ` +
      `${cell.bytesPerFrame.toFixed(0).padStart(12)} ` +
      `${(cell.bytesPerFrame / Math.max(1, cell.fleet / 2)).toFixed(0).padStart(7)}`,
  );
}

console.log(
  `\n  pub/tick is publish ÷ tick. Above 1.0, telling everybody costs more than working it out —\n` +
    `  which is Q-17.1 answered for that cell (planning/17 §2.1).`,
);

// ── The two derivatives worth naming ──────────────────────────────────────────────────

const fixedBoats = cells.filter((cell) => cell.boats === (boatsAxis[boatsAxis.length - 1] ?? 0));
const first = fixedBoats[0];
const last = fixedBoats[fixedBoats.length - 1];
if (first !== undefined && last !== undefined && last.players > first.players) {
  const playerRatio = last.players / first.players;
  console.log(
    `\n  players ${first.players} → ${last.players} at ${last.boats} boats each:\n` +
      `    fleet   ×${(last.fleet / first.fleet).toFixed(1)}  (what the solve is linear in)\n` +
      `    tick    ×${(last.tickMs / Math.max(1e-9, first.tickMs)).toFixed(1)}\n` +
      `    publish ×${(last.publishMs / Math.max(1e-9, first.publishMs)).toFixed(1)}  ` +
      `(linear in players would be ×${playerRatio.toFixed(1)}, in players×boats ×${(last.fleet / first.fleet).toFixed(1)})\n` +
      `    frame   ${kb(first.bytesPerFrame)} → ${kb(last.bytesPerFrame)}`,
  );
}

const perTeamShare = cells.filter((cell) => cell.players >= 8);
if (perTeamShare.length > 0) {
  console.log(
    `\n  Q-17.2 — a team's picture is shared but its *frame* is not: at ${perTeamShare[0]?.players} players\n` +
      `  the same picture is assembled and encoded ${(perTeamShare[0]?.players ?? 0) / 2}× per team, every frame.\n` +
      `  Run bench:netcode:bandwidth to see how much of a frame that actually is.`,
  );
}
