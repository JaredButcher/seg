/**
 * The debug probe panel (`@seg/shared/match/probe.ts`, `seg.probe`).
 *
 * One point of water read out in full, filled by ctrl+clicking the scope. It is the only panel on
 * the HUD that shows the player something they are not supposed to know, and it looks like it:
 * a plain table of numbers in the dim label colour, no accents, no gauges. That is deliberate —
 * every other instrument here is designed to be read at a glance mid-fight, and this one is
 * designed to be *copied into a bug report*.
 *
 * ## Two halves, and the second is conditional
 *
 * The water's own readings need nobody to be listening. Everything from the range down is about a
 * pair — this point, from that boat — so with nothing selected the panel says so instead of
 * showing blanks: a row of dashes reads as "the answer is nothing", where the truth is that
 * nobody asked the question.
 *
 * ## Absent is not zero
 *
 * A `null` range means sound cannot get there at all; a `null` imaging figure means the return
 * does not clear the threshold. Both print as a word rather than as a dash or a `0`, because the
 * one mistake this panel could make that would matter is letting somebody read "no path" as
 * "no distance".
 */

import type { ProbeReading } from '@seg/shared';

/** Metres, with a thin space between thousands. Whole numbers — this is a map, not a caliper. */
function metres(value: number): string {
  return `${Math.round(value).toLocaleString('en-GB').replace(/,/g, ' ')} m`;
}

/** Decibels, one place. The tables are quoted to whole numbers and the sums land between them. */
function decibels(value: number): string {
  return `${value.toFixed(1)} dB`;
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <>
      <dt className="hud-probe__label">{label}</dt>
      <dd className="hud-probe__value">{value}</dd>
    </>
  );
}

export function Probe({
  reading,
  boatName,
}: {
  readonly reading: ProbeReading | null;
  /** What the listener half's boat is called, if this client can see its name. */
  readonly boatName: string | null;
}) {
  return (
    <section className="hud-probe" aria-label="Acoustic probe">
      <h2 className="hud-panel__title">PROBE</h2>

      {reading === null ? (
        <p className="hud-probe__empty">CTRL+CLICK THE WATER TO READ A POINT.</p>
      ) : (
        <dl className="hud-probe__rows">
          <Row
            label="POINT"
            value={`${metres(reading.at.x).replace(' m', '')}, ${metres(reading.at.y)}`}
          />
          <Row label="DEPTH" value={metres(reading.depth)} />
          {/* Only when it is, because "this is rock" is news and "this is water" is not. The
              readings are taken at the water beside it — see `ProbeReading.water`. */}
          {!reading.water && <Row label="TERRAIN" value="IN ROCK — READ AT NEAREST WATER" />}
          <Row label="NOISE" value={decibels(reading.noise)} />
          <Row label="BACKGROUND" value={decibels(reading.background)} />

          {reading.listener === null ? (
            <Row label="LISTENER" value="NONE SELECTED" />
          ) : (
            <>
              <Row label="FROM" value={boatName ?? `BOAT ${String(reading.listener.boat)}`} />
              <Row
                label="RANGE"
                value={
                  reading.listener.range === null
                    ? 'NO PATH'
                    : `${metres(reading.listener.range)} (${metres(reading.listener.straight)} STRAIGHT)`
                }
              />
              <Row
                label="LOSS"
                value={reading.listener.loss === null ? '—' : decibels(reading.listener.loss)}
              />
              <Row label="SELF NOISE" value={decibels(reading.listener.selfNoise)} />
              <Row label="NOISE FLOOR" value={decibels(reading.listener.floor)} />
              <Row label="GATE" value={decibels(reading.listener.gate)} />
              {/* The reading the whole tool exists for, so it is the one with a sentence rather
                  than a label — it is meant to be compared against a hull's source level. */}
              <Row
                label="MIN AUDIBLE SL"
                value={reading.listener.audible === null ? '—' : decibels(reading.listener.audible)}
              />
              <Row
                label="IMAGING"
                value={
                  reading.listener.imaging === null
                    ? 'UNDER THRESHOLD'
                    : `+${decibels(reading.listener.imaging)}`
                }
              />
            </>
          )}
        </dl>
      )}
    </section>
  );
}
