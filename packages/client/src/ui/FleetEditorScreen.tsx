import {
  FLEET_MAX_BOATS,
  FLEET_NAME_MAX_LENGTH,
  BOAT_NAME_MAX_LENGTH,
  SLOT_LABELS,
  STAT_ORDER,
  STATS,
  boatCost,
  fleetCost,
  formatStat,
  isImprovement,
  resolveBoat,
  type BoatTemplate,
  type HullId,
  type ModuleId,
  type SlotKind,
} from '@seg/shared';
import { useEffect, useState } from 'react';

import { useFleet } from '../state/fleet.js';
import { useLobby } from '../state/lobby.js';
import { useNav } from '../state/nav.js';
import { Button, FormError } from './controls.js';
import { HullPicker, ModulePicker } from './fleet/Pickers.js';
import { HullIcon } from './HullIcon.js';

/**
 * The fleet editor. Reachable from the main menu and from a lobby (planning/07 §3), which is
 * why the draft lives in the store rather than here — navigating between the two must not
 * discard a half-built fleet.
 */
export function FleetEditorScreen() {
  const draftName = useFleet((s) => s.draftName);
  const boats = useFleet((s) => s.boats);
  const selected = useFleet((s) => s.selected);
  const savedId = useFleet((s) => s.savedId);
  const dirty = useFleet((s) => s.dirty);
  const busy = useFleet((s) => s.busy);
  const error = useFleet((s) => s.error);
  const savedAt = useFleet((s) => s.savedAt);

  const newFleet = useFleet((s) => s.newFleet);
  const refreshSaved = useFleet((s) => s.refreshSaved);
  const saveFleet = useFleet((s) => s.saveFleet);
  const setFleetName = useFleet((s) => s.setFleetName);
  const addBoat = useFleet((s) => s.addBoat);

  const [picking, setPicking] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);

  // Start on a blank fleet the first time the editor is opened, and pull the saved list so
  // the Load button can say whether there is anything to load.
  useEffect(() => {
    if (useFleet.getState().draftName === '') newFleet();
    void refreshSaved();
  }, [newFleet, refreshSaved]);

  const points = fleetCost(boats);
  const boat = selected === null ? undefined : boats[selected];

  return (
    <main className="screen screen--wide">
      <BackLink />

      <header className="screen__header">
        <h1 className="lobby__name">Fleet editor</h1>
        <p className="lobby__code">
          {boats.length} {boats.length === 1 ? 'BOAT' : 'BOATS'} · <strong>{points}</strong> POINTS
          {dirty && <span className="lobby__tag">UNSAVED</span>}
        </p>
      </header>

      <BudgetBanner points={points} />

      <div className="editor__bar panel">
        <div className="editor__name">
          <label className="field__label" htmlFor="fleet-name">
            Fleet name
          </label>
          <input
            id="fleet-name"
            className="field__input"
            value={draftName}
            maxLength={FLEET_NAME_MAX_LENGTH}
            disabled={busy}
            onChange={(e) => setFleetName(e.target.value)}
          />
        </div>
        <div className="editor__actions">
          <Button busy={busy} disabled={boats.length === 0} onClick={() => void saveFleet()}>
            {savedId === null ? 'SAVE' : 'SAVE CHANGES'}
          </Button>
          <Button variant="ghost" onClick={() => setLoadOpen(true)}>
            LOAD
          </Button>
          <Button variant="ghost" onClick={newFleet}>
            NEW
          </Button>
        </div>
      </div>

      {error !== null && <FormError>{error}</FormError>}
      {savedAt !== null && !dirty && (
        <p className="editor__saved" role="status">
          Saved.
        </p>
      )}

      <div className="editor">
        <BoatList onAdd={() => setPicking(true)} />
        {boat === undefined ? (
          <section className="panel editor__empty">
            <p className="browse__empty-text">
              {boats.length === 0
                ? 'An empty fleet. Add a boat to start.'
                : 'Select a boat to fit it out.'}
            </p>
          </section>
        ) : (
          <BoatEditor index={selected ?? 0} boat={boat} />
        )}
      </div>

      {picking && (
        <HullPicker onPick={(hull: HullId) => addBoat(hull)} onClose={() => setPicking(false)} />
      )}
      {loadOpen && <LoadDialog onClose={() => setLoadOpen(false)} />}
    </main>
  );
}

/**
 * The lobby's point budget, when the editor was opened from one.
 *
 * Shown at the top rather than beside the Save button because it changes what the player is
 * doing, not just whether one click succeeds: a fleet built to no budget and then trimmed is
 * a worse fleet than one built to the number from the start.
 *
 * Absent outside a lobby. There is no budget to measure against there, and inventing a
 * default would make every fleet look wrong somewhere.
 */
function BudgetBanner({ points }: { points: number }) {
  const budget = useLobby((s) => s.lobby?.settings.fleetPoints ?? null);
  if (budget === null) return null;

  const over = points - budget;

  return (
    <p className="editor__budget" data-over={over > 0} role="status">
      LOBBY BUDGET <strong>{budget}</strong> POINTS ·{' '}
      {over > 0 ? (
        <>
          <strong>{over} over.</strong> This fleet cannot be brought into the lobby until it fits.
        </>
      ) : (
        <>{budget - points} left</>
      )}
    </p>
  );
}

/**
 * Back to wherever the editor was opened from.
 *
 * The editor is reachable from the main menu *and* from inside a lobby, so a back button
 * hardcoded to the menu would strand a player who came from a lobby with no way back to it —
 * the lobby is still there, and the store still holds it.
 */
function BackLink() {
  const inLobby = useLobby((s) => s.lobby !== null);
  const go = useNav((s) => s.go);

  return (
    <button
      type="button"
      className="back editor__back"
      onClick={() => go(inLobby ? 'lobby' : 'home')}
    >
      <span aria-hidden="true">←</span> {inLobby ? 'BACK TO LOBBY' : 'MAIN MENU'}
    </button>
  );
}

// ── the fleet's boats ───────────────────────────────────────────────────────────

function BoatList({ onAdd }: { onAdd: () => void }) {
  const boats = useFleet((s) => s.boats);
  const selected = useFleet((s) => s.selected);
  const selectBoat = useFleet((s) => s.selectBoat);
  const removeBoat = useFleet((s) => s.removeBoat);

  return (
    <section className="panel editor__panel">
      <div className="panel__head">
        <h2 className="panel__title">Boats</h2>
        <span className="panel__meta">
          {boats.length} / {FLEET_MAX_BOATS}
        </span>
      </div>

      <div className="panel__body">
        {boats.length === 0 ? (
          <p className="roster__empty">No boats yet</p>
        ) : (
          <ul className="boats">
            {boats.map((boat, index) => (
              <li key={index} className="boats__item" data-selected={index === selected}>
                <button
                  type="button"
                  className="boats__select"
                  aria-current={index === selected}
                  onClick={() => selectBoat(index)}
                >
                  <HullIcon hull={boat.hull} width={92} />
                  <span className="boats__text">
                    <span className="boats__name">{boat.name}</span>
                    <span className="boats__meta">
                      {resolveBoat(boat).hull.name} · {boatCost(boat)} pts
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="roster__kick"
                  // The visible label is "REMOVE"; the accessible name says which boat,
                  // because a column of identical buttons tells a screen reader nothing.
                  aria-label={`Remove ${boat.name} from the fleet`}
                  onClick={() => removeBoat(index)}
                >
                  REMOVE
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="boats__add">
          <Button variant="ghost" disabled={boats.length >= FLEET_MAX_BOATS} onClick={onAdd}>
            ADD BOAT
          </Button>
        </div>
      </div>
    </section>
  );
}

// ── one boat ────────────────────────────────────────────────────────────────────

function BoatEditor({ index, boat }: { index: number; boat: BoatTemplate }) {
  const renameBoat = useFleet((s) => s.renameBoat);
  const fitModule = useFleet((s) => s.fitModule);
  const clearSlot = useFleet((s) => s.clearSlot);

  const [openSlot, setOpenSlot] = useState<{ kind: SlotKind; index: number } | null>(null);

  const resolved = resolveBoat(boat);
  const fittedInOpenSlot =
    openSlot === null
      ? null
      : (resolved.slots.find((s) => s.kind === openSlot.kind && s.index === openSlot.index)?.module
          ?.id ?? null);

  return (
    <section className="panel editor__panel">
      <div className="panel__head">
        <h2 className="panel__title">{resolved.hull.name}</h2>
        <span className="panel__meta">
          {resolved.hullCost} + {resolved.moduleCost} = {resolved.cost} pts
        </span>
      </div>

      <div className="panel__body editor__boat">
        <div className="editor__portrait">
          <HullIcon hull={boat.hull} width={280} />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="boat-name">
            Boat name
          </label>
          <input
            id="boat-name"
            className="field__input"
            value={boat.name}
            maxLength={BOAT_NAME_MAX_LENGTH}
            onChange={(e) => renameBoat(index, e.target.value)}
          />
        </div>

        {/* ── slots ── */}
        <div className="slots">
          <h3 className="slots__title">Slots</h3>
          {resolved.slots.map((slot) => (
            <button
              key={`${slot.kind}-${String(slot.index)}`}
              type="button"
              className="slot"
              data-filled={slot.module !== null}
              onClick={() => setOpenSlot({ kind: slot.kind, index: slot.index })}
            >
              <span className="slot__kind">{SLOT_LABELS[slot.kind]}</span>
              {slot.module === null ? (
                <span className="slot__empty">Empty — click to fit</span>
              ) : (
                <>
                  <span className="slot__icon" aria-hidden="true">
                    {slot.module.icon}
                  </span>
                  <span className="slot__name">{slot.module.name}</span>
                  <span className="slot__cost">{slot.module.cost} pts</span>
                </>
              )}
            </button>
          ))}
        </div>

        {/* ── stats ── */}
        <div className="stats">
          <h3 className="slots__title">Stats</h3>
          <table className="stats__table">
            <thead>
              <tr>
                <th scope="col">Stat</th>
                <th scope="col">Base</th>
                <th scope="col">Fitted</th>
              </tr>
            </thead>
            <tbody>
              {/* Generated from STAT_ORDER, so a stat added to the content table appears
                  here with no UI change. */}
              {STAT_ORDER.map((key) => {
                const base = resolved.base[key];
                const current = resolved.current[key];
                const changed = Math.abs(current - base) > 1e-9;
                return (
                  <tr key={key} data-changed={changed}>
                    <th scope="row" title={STATS[key].blurb}>
                      {STATS[key].label}
                    </th>
                    <td className="stats__base">{formatStat(key, base)}</td>
                    <td
                      className="stats__current"
                      data-better={changed ? isImprovement(key, base, current) : undefined}
                    >
                      {formatStat(key, current)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {openSlot !== null && (
        <ModulePicker
          slot={openSlot.kind}
          fitted={fittedInOpenSlot}
          base={resolved.current}
          onPick={(module: ModuleId) => fitModule(openSlot.kind, openSlot.index, module)}
          onClear={() => clearSlot(openSlot.kind, openSlot.index)}
          onClose={() => setOpenSlot(null)}
        />
      )}
    </section>
  );
}

// ── load ────────────────────────────────────────────────────────────────────────

function LoadDialog({ onClose }: { onClose: () => void }) {
  const saved = useFleet((s) => s.saved);
  const loading = useFleet((s) => s.loading);
  const dirty = useFleet((s) => s.dirty);
  const loadFleet = useFleet((s) => s.loadFleet);
  const deleteFleet = useFleet((s) => s.deleteFleet);

  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <div className="modal-shim" role="dialog" aria-modal="true" aria-label="Load a fleet">
      <div className="panel modal-shim__panel">
        <div className="panel__head">
          <h2 className="panel__title">Load a fleet</h2>
          <button type="button" className="modal__close" onClick={onClose}>
            CLOSE
          </button>
        </div>
        <div className="panel__body">
          {dirty && <p className="editor__warn">Your current fleet has unsaved changes.</p>}

          {loading ? (
            <p className="browse__empty-text">Loading…</p>
          ) : saved.length === 0 ? (
            <p className="browse__empty-text">No saved fleets yet.</p>
          ) : (
            <ul className="boats">
              {saved.map((fleet) => (
                <li key={fleet.id} className="boats__item">
                  <button
                    type="button"
                    className="boats__select"
                    onClick={() => {
                      void loadFleet(fleet.id);
                      onClose();
                    }}
                  >
                    <span className="boats__text">
                      <span className="boats__name">{fleet.name}</span>
                      <span className="boats__meta">
                        {fleet.boatCount} {fleet.boatCount === 1 ? 'boat' : 'boats'} ·{' '}
                        {fleet.points} pts
                      </span>
                    </span>
                  </button>
                  {confirming === fleet.id ? (
                    <button
                      type="button"
                      className="roster__kick roster__kick--danger"
                      onClick={() => {
                        void deleteFleet(fleet.id);
                        setConfirming(null);
                      }}
                    >
                      CONFIRM
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="roster__kick"
                      aria-label={`Delete the fleet ${fleet.name}`}
                      onClick={() => setConfirming(fleet.id)}
                    >
                      DELETE
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
