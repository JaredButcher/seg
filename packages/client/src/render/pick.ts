/**
 * @seg/client/render/pick — which boat a click on the scope landed on.
 *
 * Selection by clicking the hull is half of planning/08 §5's command interface (the fleet list
 * is the other half), and it shares the water with the movement order: the same button, on the
 * same surface, means "pick this boat" over a hull and "go here" over open water. So the rule
 * for which of the two a click is has to be exact, and it lives here rather than inside the
 * canvas host — it is arithmetic over a fleet, it decides a command, and it wants a test that
 * does not have to open a WebGL context to run.
 *
 * The shape a player aims at is the shape they can see (`silhouette.ts`), with a tolerance in
 * screen pixels around it. Metres would be the wrong unit: at full zoom-out a Light is a couple
 * of pixels of hull, and a target that shrank with the picture would be unclickable exactly
 * when the fleet view is what the player is using.
 */

import type { BoatStatus, EntityId, HullId, Vec2 } from '@seg/shared';

import { silhouetteHit } from './silhouette.js';

/**
 * How far outside a hull's outline a click still lands *on* it, CSS pixels.
 *
 * Small, because what it takes is the order the click would otherwise have issued: a boat that
 * swallowed the water around it would make the sea beside a hull un-orderable, and "click just
 * ahead of the bow" is a normal thing to want to do.
 */
export const BOAT_PICK_SLOP_PX = 8;

/** What picking needs to know about a boat. The scope's `ScopeBoat` is this plus its pulse. */
export interface PickableBoat {
  readonly id: EntityId;
  readonly hull: HullId;
  readonly pos: Vec2;
  readonly facing: number;
  readonly status: BoatStatus;
  /** Commanded by this player, rather than by a teammate. */
  readonly mine: boolean;
}

/**
 * The boat a click at `point` picks, or `null` for open water. `slop` is the tolerance in
 * **metres** — the caller divides `BOAT_PICK_SLOP_PX` by the current scale.
 *
 * **Own boats only, and no wrecks.** The fleet layer carries teammates' hulls too, and picking
 * one would select a boat this player cannot command: every following click on the water would
 * do nothing, which reads as a broken interface rather than as a rule. A wreck is the same
 * argument with the boat gone as well.
 *
 * Nearest centre wins where two hulls overlap. Overlap is ordinary — boats in company at low
 * zoom are one smudge — and "the one I was pointing at" is the only tie-break a player can
 * predict from what is on the screen.
 */
export function boatAt(
  boats: readonly PickableBoat[],
  point: Vec2,
  slop: number,
): PickableBoat | null {
  let best: PickableBoat | null = null;
  let bestDistance = Infinity;

  for (const boat of boats) {
    if (!boat.mine || boat.status === 'destroyed') continue;
    if (!silhouetteHit(boat.hull, boat.pos, boat.facing, point, slop)) continue;

    const distance = Math.hypot(point.x - boat.pos.x, point.y - boat.pos.y);
    if (distance >= bestDistance) continue;
    best = boat;
    bestDistance = distance;
  }

  return best;
}
