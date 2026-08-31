/**
 * The processing statistics panel (`@seg/shared/match/perf.ts`, `seg.stats`).
 *
 * What the server's tick is costing, up the left edge. Like the probe beside it this is an
 * instrument rather than an instrument *panel*: no gauges, no accents, a column of numbers meant
 * to be read against a budget and pasted into a bug report.
 *
 * ## The one piece of judgement it makes
 *
 * A phase over its share of the budget is marked, and nothing else is. The threshold is a share
 * rather than a duration, because the phases run at different rates — the acoustics every second
 * tick, the overlays every tenth — and "8 ms" means something different for each of them where
 * "a fifth of the budget" does not. Everything past that is left to the reader: this panel's job
 * is to be *correct*, and a HUD that decided for you which number was the problem would be wrong
 * on the day it mattered.
 *
 * ## Zero rows are still rows
 *
 * A phase that did not run in the window prints `—` and keeps its place. The list is a map of
 * where a tick goes, and holes appearing and closing as a fight starts and stops would make it
 * unreadable exactly when it is worth reading — and "the acoustics did not run at all" is itself
 * a reading.
 *
 * ## The indent is the arithmetic
 *
 * The six steps of an acoustic tick are indented under `ACOUSTICS`, which is their sum measured
 * end to end rather than added up (`PERF_SOLVE_PHASES`). Without the indent their shares would
 * appear to be parts of the budget alongside the row that already contains them, and the column
 * would add up to something like twice the truth.
 */

import {
  PERF_LABELS,
  PERF_SOLVE_PHASES,
  PERF_TOTALS,
  type PerfPhaseView,
  type SimStatsView,
} from '@seg/shared';

/** Where a phase stops being background noise and starts being worth a look. */
const HOT_SHARE = 0.2;

/** Milliseconds, to a hundredth under 10 ms and a tenth above — the range spans four decades. */
function ms(value: number): string {
  if (value <= 0) return '—';
  return value < 10 ? value.toFixed(2) : value.toFixed(1);
}

/** A share as a whole percent. Under half a percent reads as `<1` rather than as `0`. */
function percent(share: number): string {
  if (share <= 0) return '—';
  return share < 0.005 ? '<1%' : `${Math.round(share * 100).toString()}%`;
}

/** Counts, grouped by what a reader is asking when they look at them. */
function Count({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <>
      <dt className="hud-stats__label">{label}</dt>
      <dd className="hud-stats__value">{value.toLocaleString('en-GB').replace(/,/g, ' ')}</dd>
    </>
  );
}

function PhaseRow({ phase }: { readonly phase: PerfPhaseView }) {
  const total = PERF_TOTALS.includes(phase.phase);
  // Nested under `ACOUSTICS`, which is the row that already contains them.
  const inner = PERF_SOLVE_PHASES.includes(phase.phase);
  const hot = phase.share >= HOT_SHARE && !total;

  return (
    <tr
      className={`hud-stats__row${total ? ' hud-stats__row--total' : ''}${
        inner ? ' hud-stats__row--inner' : ''
      }${hot ? ' hud-stats__row--hot' : ''}`}
    >
      <th scope="row">{PERF_LABELS[phase.phase]}</th>
      <td>{ms(phase.mean)}</td>
      <td>{ms(phase.peak)}</td>
      <td>{percent(phase.share)}</td>
    </tr>
  );
}

export function Stats({ stats }: { readonly stats: SimStatsView | null }) {
  return (
    <section className="hud-stats" aria-label="Processing statistics">
      <h2 className="hud-panel__title">SERVER</h2>

      {stats === null ? (
        <p className="hud-stats__empty">WAITING FOR THE FIRST WINDOW…</p>
      ) : (
        <>
          <table className="hud-stats__phases">
            <caption className="hud-stats__caption">
              {/* What the numbers are of, carried by the payload rather than assumed — a reader
                  should not have to know the server's tick rate to read its own panel. */}
              {stats.window} TICKS · {stats.budgetMs.toFixed(0)} MS BUDGET
            </caption>
            <thead>
              <tr>
                <th scope="col">PHASE</th>
                <th scope="col">MEAN</th>
                <th scope="col">PEAK</th>
                <th scope="col">SHARE</th>
              </tr>
            </thead>
            <tbody>
              {stats.phases.map((phase) => (
                <PhaseRow key={phase.phase} phase={phase} />
              ))}
            </tbody>
          </table>

          <dl className="hud-stats__counts">
            <Count label="BOATS" value={stats.counts.boats} />
            <Count label="WEAPONS" value={stats.counts.torpedoes} />
            <Count label="ZONES" value={stats.counts.zones} />
            <Count label="ENTITIES" value={stats.counts.entities} />
            <Count label="SOURCES" value={stats.counts.sources} />
            <Count label="LISTENERS" value={stats.counts.listeners} />
            <Count label="FIELD CELLS" value={stats.counts.fieldCells} />
            {/* What each of the three expensive steps is paid per: the sweep walks every entity's
                field, the reflection pass only the listeners', and the hull skin is what a
                silhouette costs to rasterize. */}
            <Count label="LOOK CELLS" value={stats.counts.lookCells} />
            <Count label="HULL CELLS" value={stats.counts.reflectorCells} />
            <Count label="VISION CELLS" value={stats.counts.visionCells} />
            <Count label="WATER CELLS" value={stats.counts.waterCells} />
            {/* Only when it is happening: a clipped field is the tick budget's guardrail biting,
                which is news, and a permanent `0` beside it is not. */}
            {stats.counts.clippedFields > 0 && (
              <Count label="CLIPPED" value={stats.counts.clippedFields} />
            )}
          </dl>
        </>
      )}
    </section>
  );
}
