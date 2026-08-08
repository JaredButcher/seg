import {
  HULL_IDS,
  SLOT_LABELS,
  STATS,
  formatStat,
  getHull,
  modulesForSlot,
  type HullId,
  type Modifier,
  type ModuleId,
  type SlotKind,
  type Stats,
} from '@seg/shared';
import { type ReactNode, useEffect, useRef } from 'react';

import { HullIcon } from '../HullIcon.js';

/**
 * A modal panel.
 *
 * Native `<dialog>` gets focus trapping, Escape, and inertness on the rest of the page for
 * free — all of which would otherwise be hand-rolled and half-right.
 */
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="modal"
      onClose={onClose}
      // Clicking the backdrop closes. The dialog element itself is the event target only
      // when the click landed outside its content box.
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <div className="modal__head">
        <h2 className="modal__title">{title}</h2>
        <button type="button" className="modal__close" onClick={() => ref.current?.close()}>
          CLOSE
        </button>
      </div>
      <div className="modal__body">{children}</div>
    </dialog>
  );
}

// ── hull picker ─────────────────────────────────────────────────────────────────

/** Adds a boat. Shows each hull's base stats so the choice is informed, not a guess. */
export function HullPicker({
  onPick,
  onClose,
}: {
  onPick: (hull: HullId) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Add a boat" onClose={onClose}>
      <ul className="picker">
        {HULL_IDS.map((id) => {
          const hull = getHull(id);
          return (
            <li key={id}>
              <button
                type="button"
                className="picker__item picker__item--hull"
                onClick={() => {
                  onPick(id);
                  onClose();
                }}
              >
                <HullIcon hull={id} width={150} />
                <span className="picker__main">
                  <span className="picker__name">
                    {hull.name}
                    <span className="picker__cost">{hull.cost} pts</span>
                  </span>
                  <span className="picker__role">
                    {hull.role} · {hull.length} m · {hull.slots.equipment} equipment,{' '}
                    {hull.slots.weapon} weapon
                  </span>
                  <span className="picker__desc">{hull.description}</span>
                  <span className="picker__stats">
                    {(['maxHp', 'maxSpeed', 'sourceLevel', 'crushDepth'] as const).map((key) => (
                      <span key={key} className="picker__stat">
                        <span className="picker__stat-label">{STATS[key].label}</span>
                        <span className="picker__stat-value">
                          {formatStat(key, hull.stats[key])}
                        </span>
                      </span>
                    ))}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

// ── module picker ───────────────────────────────────────────────────────────────

/**
 * Fills or empties one slot.
 *
 * Only modules whose declared slot matches are listed — the shared table decides, so the
 * editor cannot offer something the server would refuse.
 */
export function ModulePicker({
  slot,
  fitted,
  base,
  onPick,
  onClear,
  onClose,
}: {
  slot: SlotKind;
  fitted: ModuleId | null;
  /** The boat's current stats, so each option can preview what it would change. */
  base: Stats;
  onPick: (module: ModuleId) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const options = modulesForSlot(slot);

  return (
    <Modal title={`${SLOT_LABELS[slot]} slot`} onClose={onClose}>
      <ul className="picker">
        {fitted !== null && (
          <li>
            <button
              type="button"
              className="picker__item picker__item--clear"
              onClick={() => {
                onClear();
                onClose();
              }}
            >
              <span className="picker__icon" aria-hidden="true">
                ✕
              </span>
              <span className="picker__main">
                <span className="picker__name">Empty this slot</span>
                <span className="picker__desc">
                  Removes the fitted module and refunds its cost.
                </span>
              </span>
            </button>
          </li>
        )}

        {options.map((module) => (
          <li key={module.id}>
            <button
              type="button"
              className="picker__item"
              aria-current={fitted === module.id}
              onClick={() => {
                onPick(module.id);
                onClose();
              }}
            >
              <span className="picker__icon" aria-hidden="true">
                {module.icon}
              </span>
              <span className="picker__main">
                <span className="picker__name">
                  {module.name}
                  <span className="picker__cost">{module.cost} pts</span>
                  {fitted === module.id && <span className="picker__badge">FITTED</span>}
                </span>
                <span className="picker__desc">{module.description}</span>
                <span className="picker__effects">
                  {module.modifiers.map((mod) => (
                    <ModifierChip key={`${mod.stat}-${mod.op}`} mod={mod} base={base} />
                  ))}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/**
 * One modifier, rendered as the change it would make.
 *
 * Shows the resulting delta rather than the raw op, because "+30% turn rate" means nothing
 * next to "1.7 → 2.2 °/s" when the player is comparing two hulls.
 */
function ModifierChip({ mod, base }: { mod: Modifier; base: Stats }) {
  const meta = STATS[mod.stat];
  const from = base[mod.stat];
  const to =
    mod.op === 'add'
      ? from + mod.value
      : mod.op === 'mul'
        ? from * mod.value
        : mod.op === 'set'
          ? mod.value
          : from;

  const better = meta.better === 'higher' ? to > from : to < from;
  const changed = Math.abs(to - from) > 1e-9;

  return (
    <span className="chip" data-better={changed ? better : undefined}>
      {meta.label} {formatStat(mod.stat, from)} → {formatStat(mod.stat, to)}
    </span>
  );
}
