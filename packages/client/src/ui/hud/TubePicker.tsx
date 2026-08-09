/**
 * What a tube loads next — the small popup over a tube pip (planning/08 §5).
 *
 * Deliberately *not* the `<dialog>` the fleet editor uses. That one is a modal over a screen
 * where the player is planning; this one opens over a running match, and a modal would make the
 * ocean inert while a torpedo was in the water. It is a popover anchored to the pip that opened
 * it, the match keeps running behind it, and Escape or a click anywhere else puts it away.
 *
 * ## Two commands on one list
 *
 * A plain click **queues** the load: nothing about the tube changes now, and the choice takes
 * effect when the tube next cycles. A **shift**-click *swaps* — the weapon in the tube is ejected
 * over `UNLOAD_SECONDS` and the new one loaded behind it (`match/tubes.ts`), which costs the
 * tube an unload and a reload and is the price of changing your mind about something you are
 * already holding.
 *
 * Both are on the same row rather than on two, because they are the same decision made with
 * different urgency, and a separate "swap" column would be a second thing to read on a control
 * the player is using while being shot at. The modifier is stated on the panel, and shift-held
 * relabels every row so the player can see which command they are about to give before they give
 * it.
 */

import {
  DEPLOYABLE_WEAPON_IDS,
  UNLOAD_SECONDS,
  getWeapon,
  type TubeState,
  type WeaponId,
} from '@seg/shared';
import { useEffect, useState } from 'react';

import { useEscape } from '../escape.js';

interface TubePickerProps {
  readonly tube: TubeState;
  /** Which boat, for the accessible name — the panel can be open over any row. */
  readonly boatName: string;
  readonly onPick: (weapon: WeaponId, swap: boolean) => void;
  readonly onClose: () => void;
}

export function TubePicker({ tube, boatName, onPick, onClose }: TubePickerProps) {
  /*
   * Shift is tracked rather than only read at the click, so the panel can *say* what a click
   * will do. A modifier whose effect is invisible until after it has fired is a modifier players
   * do not use, and this one destroys a loaded weapon.
   */
  const [swapping, setSwapping] = useState(false);

  useEffect(() => {
    const update = (event: KeyboardEvent) => setSwapping(event.shiftKey);
    // `blur` as well: alt-tabbing away while shift is down eats the keyup, and the panel would
    // otherwise sit there claiming the next click will eject a torpedo.
    const release = () => setSwapping(false);
    window.addEventListener('keydown', update);
    window.addEventListener('keyup', update);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', update);
      window.removeEventListener('keyup', update);
      window.removeEventListener('blur', release);
    };
  }, []);

  useEscape(onClose);

  // Closing on any press outside is what makes this a popover rather than a mode. Captured on
  // the way down so a click meant to dismiss the panel does not also reach the scope behind it
  // and order a boat somewhere.
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && document.querySelector('.tube-picker')?.contains(target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', dismiss, { capture: true });
    return () => window.removeEventListener('pointerdown', dismiss, { capture: true });
  }, [onClose]);

  return (
    <div
      className="tube-picker"
      role="dialog"
      aria-label={`${boatName} tube ${String(tube.index + 1)}: choose the next load`}
    >
      <p className="tube-picker__head">
        TUBE {tube.index + 1}
        <span className="tube-picker__now">
          {tube.status === 'loaded'
            ? getWeapon(tube.weapon).abbreviation
            : tube.status === 'unloading'
              ? 'EMPTYING'
              : tube.status === 'reloading'
                ? 'LOADING'
                : 'OUT'}
        </span>
      </p>

      <ul className="tube-picker__list">
        {DEPLOYABLE_WEAPON_IDS.map((id) => {
          const weapon = getWeapon(id);
          const queued = tube.next === id;
          // Swapping to what is already in the tube would spend a full cycle to end up exactly
          // where it started, which is never what a player meant by it.
          const swap = swapping && tube.status === 'loaded' && tube.weapon !== id;

          return (
            <li key={id}>
              <button
                type="button"
                className="tube-picker__item"
                aria-current={queued}
                onClick={(event) => {
                  onPick(id, event.shiftKey && tube.status === 'loaded' && tube.weapon !== id);
                  onClose();
                }}
              >
                <span className="tube-picker__abbr" aria-hidden="true">
                  {weapon.abbreviation}
                </span>
                <span className="tube-picker__main">
                  <span className="tube-picker__name">
                    {weapon.name}
                    {queued && !swap && <span className="tube-picker__badge">NEXT</span>}
                    {swap && (
                      <span className="tube-picker__badge tube-picker__badge--swap">SWAP</span>
                    )}
                  </span>
                  <span className="tube-picker__stats">
                    {weapon.speed} m/s · {weapon.range} m · ±{weapon.maxPitch}° ·{' '}
                    {weapon.seeker === 'none' ? 'no seeker' : 'active seeker'}
                  </span>
                  <span className="tube-picker__desc">{weapon.description}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="tube-picker__hint">
        {swapping
          ? `SHIFT — EMPTY THE TUBE NOW, ${UNLOAD_SECONDS} S THEN RELOAD`
          : 'CLICK TO QUEUE · SHIFT-CLICK TO EMPTY AND RELOAD NOW'}
      </p>
    </div>
  );
}
