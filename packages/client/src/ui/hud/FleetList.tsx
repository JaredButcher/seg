/**
 * The fleet list (planning/08 §11, element 3; §5). Right edge, above the mini-map.
 *
 * One row per boat **you** command, in fixed fleet order — the order never re-sorts, because
 * a list that reorders itself under the cursor is unusable as a command surface (§6). Each
 * row carries what the spec asks for: name, class, hit points, **depth**, throttle notch,
 * test/crush proximity, cavitation state, and per-tube status.
 *
 * At 3–5 boats it is a readout; at 6–10 it becomes the interface. It is built for the second
 * case and looks calm in the first, which is the cheaper way round.
 *
 * Clicking a row snaps the camera to the boat. It does **not** select it — selection means
 * "these boats take my next order" and there are no orders yet (planning/08 §5), so a row
 * that highlighted as selected would be promising something the build cannot do.
 */

import {
  getHull,
  getWeapon,
  THROTTLE_LABELS,
  type MatchSetup,
  type MatchViewState,
} from '@seg/shared';

import { Pending } from '../Pending.js';
import { formatDepth, formatPitch, fleetRows, type FleetRow } from './rows.js';

interface FleetListProps {
  readonly setup: MatchSetup;
  readonly view: MatchViewState;
  /** Centre the scope on a boat. */
  readonly onFocus: (row: FleetRow) => void;
}

export function FleetList({ setup, view, onFocus }: FleetListProps) {
  const rows = fleetRows(setup, view);

  return (
    <section className="hud-fleet" aria-label="Fleet">
      <h2 className="hud-panel__title">FLEET</h2>

      {rows.length === 0 ? (
        <p className="hud-fleet__empty">
          {setup.you.team === null
            ? 'Spectating. Nothing to command.'
            : 'No boats deployed — the fleet you brought could not be read.'}
        </p>
      ) : (
        <ol className="hud-fleet__rows">
          {rows.map((row) => (
            <Row key={row.profile.id} row={row} onFocus={onFocus} />
          ))}
        </ol>
      )}

      <Pending
        milestone="M2"
        heading="Ordering arrives with the command interface"
        what={
          <>
            A row reads and jumps the camera. Selecting a boat, setting its throttle, and giving it
            somewhere to go all need commands the protocol does not carry yet.
          </>
        }
      />
    </section>
  );
}

function Row({
  row,
  onFocus,
}: {
  readonly row: FleetRow;
  readonly onFocus: (row: FleetRow) => void;
}) {
  const { profile, snapshot, tubes, depth, standing, integrity, cavitating } = row;
  const hull = getHull(profile.hull);
  const lost = snapshot.status === 'destroyed';

  return (
    <li className={lost ? 'hud-boat hud-boat--lost' : 'hud-boat'}>
      <button
        type="button"
        className="hud-boat__hit"
        onClick={() => onFocus(row)}
        aria-label={`${profile.name}, ${hull.name}, ${formatDepth(depth)} deep. Centre the scope on it.`}
      >
        <span className="hud-boat__head">
          <span className="hud-boat__name">{profile.name}</span>
          <span className="hud-boat__class">{hull.name.toUpperCase()}</span>
        </span>

        {lost ? (
          <span className="hud-boat__lost">LOST</span>
        ) : (
          <>
            <span className="hud-boat__bar" aria-hidden="true">
              <span
                className={integrity < 0.5 ? 'hud-boat__hp hud-boat__hp--hurt' : 'hud-boat__hp'}
                style={{ inlineSize: `${String(Math.max(0, Math.round(integrity * 100)))}%` }}
              />
            </span>

            <span className="hud-boat__line">
              <span className={`hud-boat__depth hud-boat__depth--${standing}`}>
                {formatDepth(depth)}
              </span>
              <span className="hud-boat__pitch">{formatPitch(snapshot.facing)}</span>
              <span
                className={cavitating ? 'hud-boat__notch hud-boat__notch--loud' : 'hud-boat__notch'}
              >
                {THROTTLE_LABELS[snapshot.throttle]}
              </span>
            </span>

            <span className="hud-boat__tubes" aria-label={`${String(tubes.length)} tubes`}>
              {tubes.map((tube) => (
                <span
                  className={`hud-tube hud-tube--${tube.status}`}
                  key={tube.index}
                  title={`Tube ${String(tube.index + 1)}: ${getWeapon(tube.weapon).name}`}
                >
                  {getWeapon(tube.weapon).abbreviation}
                </span>
              ))}
            </span>

            <span className="hud-boat__order">
              {snapshot.order.kind === 'hold' ? 'HOLDING' : 'TRANSIT'}
            </span>
          </>
        )}
      </button>
    </li>
  );
}
