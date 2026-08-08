import { useEffect } from 'react';

import { useFleet } from '../../state/fleet.js';

/**
 * Choose which saved fleet to bring into a lobby.
 *
 * Fleets over the lobby's budget are listed but not selectable. Hiding them would be worse:
 * a player who spent an evening on a 900-point fleet needs to see it sitting there over the
 * line, not wonder whether it was deleted.
 *
 * The gate here is a courtesy. `LobbyService.selectFleet` is what actually enforces the
 * budget, and it re-checks whenever the fleet or the budget changes.
 */
export function FleetPicker({
  budget,
  selectedId,
  onSelect,
  onClose,
}: {
  budget: number;
  selectedId: string | null;
  onSelect: (fleetId: string | null) => void;
  onClose: () => void;
}) {
  const saved = useFleet((s) => s.saved);
  const loading = useFleet((s) => s.loading);
  const refreshSaved = useFleet((s) => s.refreshSaved);

  // Re-read on open rather than trusting whatever the editor last left behind: the list
  // carries the point values this dialog is about to gate on.
  useEffect(() => {
    void refreshSaved();
  }, [refreshSaved]);

  const affordable = saved.filter((fleet) => fleet.points <= budget);

  return (
    <div className="modal-shim" role="dialog" aria-modal="true" aria-label="Choose a fleet">
      <div className="panel modal-shim__panel">
        <div className="panel__head">
          <h2 className="panel__title">Choose a fleet</h2>
          <span className="panel__meta">{budget} point budget</span>
          <button type="button" className="modal__close" onClick={onClose}>
            CLOSE
          </button>
        </div>

        <div className="panel__body">
          {loading ? (
            <p className="browse__empty-text">Loading…</p>
          ) : saved.length === 0 ? (
            <p className="browse__empty-text">
              No saved fleets yet. Build one in the fleet editor first.
            </p>
          ) : (
            <>
              {affordable.length === 0 && (
                <p className="editor__warn">
                  None of your fleets fit in {budget} points. Edit one down, or ask the host to
                  raise the budget.
                </p>
              )}

              <ul className="boats">
                {saved.map((fleet) => {
                  const overBy = fleet.points - budget;
                  const overBudget = overBy > 0;
                  return (
                    <li
                      key={fleet.id}
                      className="boats__item"
                      data-selected={fleet.id === selectedId}
                    >
                      <button
                        type="button"
                        className="boats__select"
                        disabled={overBudget}
                        aria-current={fleet.id === selectedId}
                        onClick={() => {
                          onSelect(fleet.id);
                          onClose();
                        }}
                      >
                        <span className="boats__text">
                          <span className="boats__name">
                            {fleet.name}
                            {fleet.id === selectedId && (
                              <span className="picker__badge">SELECTED</span>
                            )}
                          </span>
                          <span className="boats__meta">
                            {fleet.boatCount} {fleet.boatCount === 1 ? 'boat' : 'boats'} ·{' '}
                            {fleet.points} pts
                            {overBudget && (
                              <span className="boats__over"> · {overBy} over budget</span>
                            )}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {selectedId !== null && (
            <div className="boats__add">
              <button
                type="button"
                className="roster__kick"
                onClick={() => {
                  onSelect(null);
                  onClose();
                }}
              >
                BRING NO FLEET
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
