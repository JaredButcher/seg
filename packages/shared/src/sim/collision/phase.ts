/**
 * The collision phase — step 4 of planning/04 §1's tick, in pure form.
 *
 * Movement has already run and produced where every boat *would like* to be. This decides which
 * of those places are legal, and it does it the same way for rock and for another hull: **the step
 * is refused.** The boat is put back where it was, stopped, and dropped to `hold`.
 *
 * ## Why refusal, and not a slide or a bounce
 *
 * A slide along the wall would be the arcade answer and it is the wrong one for this game: it
 * silently converts a bad order into a different order, and a boat that ends up somewhere the
 * player did not send it — quietly, while they were looking at another part of the map — is worse
 * than one that stopped. A bounce is worse again, because the boat leaves under a heading nobody
 * chose.
 *
 * Refusal also has a property the alternatives do not: it cannot put a hull inside stone. The
 * position it falls back to is one the boat *already occupied*, so it was legal a tick ago and it
 * is legal now.
 *
 * The order is cleared rather than kept for a plainer reason. A boat that kept its route would
 * accelerate back into the wall on the next tick, hit it again, and go on doing so — one impact
 * per second for the rest of the match, each a +30 dB bang audible across the map. Clearing it
 * makes contact a single event, and makes it visible: the route line the player was given as the
 * receipt for their order (`render/ScopeHost`) disappears.
 *
 * ## What a contact costs
 *
 * - **Rock: nothing but the stop.** Terrain damage is designed (Q39) and deliberately not built
 *   here — this phase exists first so that there is something for damage to fail against.
 * - **A hull: minor damage to both boats**, scaled by closing speed (`hulls.ts`).
 * - **Both are loud**, past the grazing threshold: `bottoming` for rock, `collision` for a hull.
 *   Under it, a contact is silent as well as harmless, which is the whole of Q39's answer.
 *
 * ## Already in contact means free to move
 *
 * Every test is "does this end in contact, *and did the last one not*". A boat that begins a tick
 * overlapping something is allowed to move however it likes, including further in, because the
 * alternative is a boat frozen for the rest of the match with no way out. That state should not
 * arise — deployment berths hulls in water with room around them (`match/deploy.ts`) — but it is
 * reachable through a crowded deployment band, and "stuck forever" is the one failure a player can
 * do nothing about.
 */

import { HOLDING, withTransient, type BoatState } from '../../match/world.js';
import { closingSpeed, collisionDamage, hullsTouch, GRAZE_SPEED } from './hulls.js';
import type { TerrainCollider } from './terrain.js';

export interface CollisionPhase {
  /**
   * The fleet as it was before this tick's movement, index-aligned with `after`.
   *
   * Both arrays are the same boats in the same order — the runtime produces `after` by mapping
   * over `before`, so this holds by construction. It is what lets a refusal be a position lookup
   * rather than a search.
   */
  readonly before: readonly BoatState[];
  /** The fleet as movement would have it. */
  readonly after: readonly BoatState[];
  /** The map's rock, or `null` on a map with no terrain to hit. */
  readonly terrain: TerrainCollider | null;
  readonly tick: number;
  readonly tickHz: number;
}

/**
 * Resolve every contact this tick produced.
 *
 * Returns `after` itself when nothing touched anything, which is the overwhelming majority of
 * ticks — the same bargain `MatchRuntime#pulse` makes, so a quiet tick allocates nothing and
 * leaves the fleet referentially unchanged.
 *
 * One pass, not a solver. Refusing a step can in principle open a fresh overlap — boat A put back
 * where boat B has just arrived — and that residue is left for the next tick to resolve rather
 * than iterated to a fixed point. It lasts 50 ms, it is invisible at any zoom, and both boats
 * involved are now stopped, so the next tick's test converges instead of oscillating.
 */
export function resolveCollisions(phase: CollisionPhase): readonly BoatState[] {
  const { before, after, terrain, tick, tickHz } = phase;

  let touched = false;
  const settled = after.slice();

  // ── rock ──────────────────────────────────────────────────────────────────────
  if (terrain !== null) {
    for (let i = 0; i < settled.length; i += 1) {
      const candidate = settled[i];
      const previous = before[i];
      if (candidate === undefined || previous === undefined) continue;
      if (candidate.status === 'destroyed') continue;
      // A boat that did not move cannot have moved into anything, and most of a fleet most of the
      // time has not moved. The check is on the coordinates rather than on the object so that it
      // does not quietly depend on `stepBoat` handing back the same `pos` it was given.
      if (candidate.pos.x === previous.pos.x && candidate.pos.y === previous.pos.y) continue;
      if (!terrain.hitsBoat(candidate)) continue;
      // The expensive half, and it only runs for a boat that has actually ended up in stone.
      if (terrain.hitsBoat(previous)) continue;

      touched = true;
      settled[i] = refuse(
        previous,
        candidate,
        'bottoming',
        candidate.speed >= GRAZE_SPEED,
        tick,
        tickHz,
      );
    }
  }

  // ── hulls ─────────────────────────────────────────────────────────────────────
  // Damage is gathered before anything is applied so that a boat caught between two others takes
  // both impacts. Applying them as they are found would work too and would read as if the order
  // of the loop mattered, which is the sort of thing that quietly stops being true.
  const damage = new Float64Array(settled.length);
  const collided: boolean[] = new Array<boolean>(settled.length).fill(false);
  const loud: boolean[] = new Array<boolean>(settled.length).fill(false);

  for (let i = 0; i < settled.length; i += 1) {
    for (let j = i + 1; j < settled.length; j += 1) {
      const a = settled[i];
      const b = settled[j];
      const wasA = before[i];
      const wasB = before[j];
      if (a === undefined || b === undefined || wasA === undefined || wasB === undefined) continue;
      if (!hullsTouch(a, b)) continue;
      if (hullsTouch(wasA, wasB)) continue;

      const closing = closingSpeed(a, b);
      const hurt = collisionDamage(closing);
      touched = true;
      collided[i] = collided[j] = true;
      if (closing >= GRAZE_SPEED) loud[i] = loud[j] = true;
      damage[i] = (damage[i] ?? 0) + hurt;
      damage[j] = (damage[j] ?? 0) + hurt;
    }
  }

  for (let i = 0; i < settled.length; i += 1) {
    if (collided[i] !== true) continue;
    const candidate = settled[i];
    const previous = before[i];
    if (candidate === undefined || previous === undefined) continue;

    const stopped = refuse(previous, candidate, 'collision', loud[i] === true, tick, tickHz);
    settled[i] = hurtBy(stopped, damage[i] ?? 0, tick, tickHz);
  }

  return touched ? settled : after;
}

/**
 * Put a boat back where it came from, stopped and holding, and sound the impact if it was hard
 * enough to be heard.
 *
 * **Facing is kept, not reverted.** The boat has turned into the wall and the turn is what will
 * get it out again: a hull pinned nose-first against rock with its heading rolled back would be
 * pointing exactly where it was pointing when it hit, and the player's next order would drive it
 * straight back in.
 */
function refuse(
  previous: BoatState,
  candidate: BoatState,
  kind: 'bottoming' | 'collision',
  heard: boolean,
  tick: number,
  tickHz: number,
): BoatState {
  const stopped: BoatState = { ...candidate, pos: previous.pos, speed: 0, order: HOLDING };
  return heard ? withTransient(stopped, kind, tick, tickHz) : stopped;
}

/**
 * Take hit points off a boat, and destroy it if that was the last of them.
 *
 * Collision is not the only damage source any more (`sim/weapons/phase.ts#hurt`), but it is still
 * the one that can do this quietly if it is not careful: `refuse` has already sounded `collision`
 * for the impact, so a boat this finishes off gets `hull-destroyed` on top — the louder,
 * longer event planning/04 §8 (revised) wants for the moment a hull actually fails, distinct
 * from the impact that caused it. The rule underneath both is unchanged: zero hit points is
 * destroyed, and there is no repair.
 */
function hurtBy(boat: BoatState, amount: number, tick: number, tickHz: number): BoatState {
  if (amount <= 0) return boat;
  const hp = Math.max(0, boat.hp - amount);
  if (hp > 0) return { ...boat, hp };
  return withTransient({ ...boat, hp, status: 'destroyed' }, 'hull-destroyed', tick, tickHz);
}
