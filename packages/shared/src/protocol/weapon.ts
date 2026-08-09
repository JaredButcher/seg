/**
 * @seg/shared/protocol/weapon — the two things a player can do with a tube.
 *
 * Both follow the shape `match.setActiveSonar` set (`protocol/match.ts`): name a boat by id, say
 * what you are *asking for* rather than what the result is, and take the answer in the view frame
 * you are already receiving. There is no `weapon.accepted` — the tube going into reload, and the
 * torpedo appearing in `MatchViewState.torpedoes`, are the receipt.
 *
 * ## Firing is a salvo, not a shot
 *
 * `weapon.fire` carries a **list** of tubes rather than one, because the gesture it comes from is
 * one gesture: the player sub-selects tubes with ctrl+number and then presses space with the
 * cursor on a point, and every selected tube fires at that point together. Sending one message per tube would put a
 * salvo's atomicity in the client's hands — an unreliable `commands` channel could deliver three
 * of four, and the server would have no way to know it was ever meant to be four.
 *
 * ## Neither is idempotent, and both are safe anyway
 *
 * `match.setActiveSonar` could be idempotent because it names a state. Firing names an *action*,
 * and a duplicate really would be a second salvo. What makes that survivable is that the second
 * one hits tubes that are now reloading and is refused by the tube rules — a redelivered fire
 * command costs nothing because the world has already moved past it. `weapon.load` is genuinely
 * idempotent when it is not a swap, and a duplicated swap re-ejects a tube that is already
 * empty, which the same rule refuses.
 */

import type { WeaponId } from '../content/weapons.js';
import type { Vec2 } from '../map/types.js';
import type { EntityId } from '../match/world.js';
import type { Envelope } from './schema.js';

/**
 * "Fire these tubes at this point."
 *
 * `to` means two different things depending on what is loaded, and the client does not get to
 * decide which: for a homing torpedo it is the **enable point** where the seeker wakes up, and
 * for a super-cavitating one it is simply where the weapon is aimed (`match/torpedo.ts#aim`).
 * One field, because the player performs one gesture and the difference belongs to the load.
 */
export interface WeaponFireMessage extends Envelope {
  readonly t: 'weapon.fire';
  readonly boat: EntityId;
  /**
   * Tube indices, 0-based. Empty means "the first tube that can fire", which is what a bare
   * space press with nothing sub-selected does — the common case, and the one a player who has
   * never read a key binding will find.
   */
  readonly tubes: readonly number[];
  readonly to: Vec2;
}

/**
 * "Load this next" — or, with `swap`, "load it now and throw away what is in there".
 *
 * The plain form changes nothing about the tube's current state; it is a note about the *next*
 * cycle, which is the whole reason `TubeState.next` exists. The swap form is the shift-held
 * version and it costs the tube an unload and a reload (`match/tubes.ts`), which is the price of
 * changing your mind about a weapon you are already holding.
 */
export interface WeaponLoadMessage extends Envelope {
  readonly t: 'weapon.load';
  readonly boat: EntityId;
  readonly tube: number;
  readonly weapon: WeaponId;
  /** Eject what is loaded and start over, rather than only queueing this behind the next shot. */
  readonly swap: boolean;
}

export type WeaponClientMessage = WeaponFireMessage | WeaponLoadMessage;

// ── helpers ─────────────────────────────────────────────────────────────────────────

export function createWeaponFire(
  boat: EntityId,
  tubes: readonly number[],
  to: Vec2,
): WeaponFireMessage {
  return { t: 'weapon.fire', boat, tubes, to };
}

export function createWeaponLoad(
  boat: EntityId,
  tube: number,
  weapon: WeaponId,
  swap: boolean,
): WeaponLoadMessage {
  return { t: 'weapon.load', boat, tube, weapon, swap };
}
