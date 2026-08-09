/**
 * @seg/shared/protocol/nav — the navigation commands.
 *
 * The first command messages, on `commands` (planning/02 §3.2): the player's orders to their
 * own boats. Only two verbs today — point the boat at something, or take its orders away — plus
 * the throttle that decides how fast it travels. Everything the server lets a boat do arrives
 * through here, and every message names the boat by id so the server can check who owns it.
 *
 * There is no acknowledgement shape. Orders are echoed back, visibly and in the world, in the
 * next view frame: the line through the boat's waypoints *is* the receipt.
 */

import type { Vec2 } from '../map/types.js';
import type { EntityId, ThrottleNotch } from '../match/world.js';
import type { Envelope } from './schema.js';

/** "Go to this point." Queued with shift-click, which is what `queue` carries. */
export interface NavOrderMessage extends Envelope {
  readonly t: 'nav.order';
  readonly boat: EntityId;
  readonly to: Vec2;
  /**
   * Append to the boat's current route rather than replacing it. The server owns the route —
   * this flag is how the client asks to add a leg, not how it asserts what the route is.
   */
  readonly queue: boolean;
}

/** "Drop every order and stop." Right-click, on a boat that has somewhere to go. */
export interface NavCancelMessage extends Envelope {
  readonly t: 'nav.cancel';
  readonly boat: EntityId;
}

/** "Set the throttle notch." Speed for the next and current orders. */
export interface NavThrottleMessage extends Envelope {
  readonly t: 'nav.throttle';
  readonly boat: EntityId;
  readonly notch: ThrottleNotch;
}

export type NavClientMessage = NavOrderMessage | NavCancelMessage | NavThrottleMessage;

// ── helpers ─────────────────────────────────────────────────────────────────────────

export function createNavOrder(boat: EntityId, to: Vec2, queue: boolean): NavOrderMessage {
  return { t: 'nav.order', boat, to, queue };
}

export function createNavCancel(boat: EntityId): NavCancelMessage {
  return { t: 'nav.cancel', boat };
}

export function createNavThrottle(boat: EntityId, notch: ThrottleNotch): NavThrottleMessage {
  return { t: 'nav.throttle', boat, notch };
}
