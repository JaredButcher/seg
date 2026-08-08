/**
 * @seg/shared/match/world — what a boat *is*, as the server holds it.
 *
 * This is the data model only. Nothing here integrates, decides, or ticks: movement,
 * collision, weapons, and acoustics arrive with the simulation (planning/04 §1). What this
 * file settles is the vocabulary those systems will mutate — which is the part that is
 * expensive to change later, because the wire, the HUD, and the replay format all quote it.
 *
 * ## The frame
 *
 * Positions are **map space**: metres, x rightward, y upward from the seabed (`map/types.ts`).
 * That is the frame the generator emits, the renderer draws, and the collision polygons will
 * live in, so it is the one boats use too — a second frame with a conversion in the middle is
 * how a bearing ends up mirrored in exactly one consumer.
 *
 * `facing` is degrees, `0` along `+x`, **positive counter-clockwise** — which in a y-up frame
 * is up-and-right, exactly as planning/04 §4 describes it. Depth is derived from `pos.y`
 * (`depthAt`) and is never stored: two sources for one fact is two facts eventually.
 */

import type { HullId } from '../content/hulls.js';
import type { Stats } from '../content/stats.js';
import type { WeaponId } from '../content/weapons.js';
import type { LobbyPosition } from '../lobby/settings.js';
import type { Vec2 } from '../map/types.js';

// ── Identity ────────────────────────────────────────────────────────────────────────

/**
 * One entity in a match, unique for that match's lifetime.
 *
 * Numeric rather than a string: it is the most-repeated field on the wire once view frames
 * flow, and the binary codec wants an integer it can size (planning/02 §4). Ids are handed
 * out in order and never reused, so a stale reference is missing rather than wrong.
 */
export type EntityId = number;

/**
 * Which side. The lobby's `team1`/`team2` vocabulary, kept rather than translated to the
 * numeric `TeamId` planning/04 §4 sketches.
 *
 * The translation would have to exist in the lobby, the match, the wire, the HUD, and the
 * replay, and it buys nothing until something indexes an array by team — at which point
 * `TEAM_IDS.indexOf` is right there. One vocabulary end to end is worth more than one byte.
 */
export type TeamId = 'team1' | 'team2';

export const TEAM_IDS: readonly TeamId[] = ['team1', 'team2'];

export function isTeamId(value: unknown): value is TeamId {
  return value === 'team1' || value === 'team2';
}

export function opposingTeam(team: TeamId): TeamId {
  return team === 'team1' ? 'team2' : 'team1';
}

/** Which team a lobby seat plays for. `null` for a spectator, who plays for neither. */
export function teamOf(position: LobbyPosition): TeamId | null {
  return position === 'spectator' ? null : position;
}

/** Player-facing label. Kept beside the ids so the two cannot drift. */
export function describeTeam(team: TeamId): string {
  return team === 'team1' ? 'Team 1' : 'Team 2';
}

// ── Throttle ────────────────────────────────────────────────────────────────────────

/**
 * The throttle is notched, not continuous (planning/08 §5, 09 §9).
 *
 * Notches rather than a slider because the control has to be readable at a glance across a
 * ten-row fleet list and settable with one key, and because the interesting question is never
 * "8.4 or 8.6 m/s" — it is "am I above the cavitation line". A notch is a decision; a slider
 * is a fidget.
 */
export const THROTTLE_NOTCHES = ['stop', 'creep', 'slow', 'standard', 'full', 'flank'] as const;
export type ThrottleNotch = (typeof THROTTLE_NOTCHES)[number];

/** Fraction of the boat's `maxSpeed` each notch demands. First-pass, evenly spaced. */
export const THROTTLE_FRACTIONS: Readonly<Record<ThrottleNotch, number>> = {
  stop: 0,
  creep: 0.2,
  slow: 0.4,
  standard: 0.6,
  full: 0.8,
  flank: 1,
};

export const THROTTLE_LABELS: Readonly<Record<ThrottleNotch, string>> = {
  stop: 'STOP',
  creep: 'CREEP',
  slow: 'SLOW',
  standard: 'STD',
  full: 'FULL',
  flank: 'FLANK',
};

/** The speed a notch demands of a given boat. */
export function throttleSpeed(notch: ThrottleNotch, maxSpeed: number): number {
  return THROTTLE_FRACTIONS[notch] * maxSpeed;
}

/**
 * The highest notch that still stays under the cavitation threshold.
 *
 * This is the mark drawn on the throttle control (planning/08 §5) — the fastest a boat can go
 * without screaming. It moves as the boat's depth changes once the depth term exists, which is
 * why it is computed from a speed rather than baked into the notch table.
 */
export function quietestLoudNotch(stats: Stats): ThrottleNotch {
  let quiet: ThrottleNotch = 'stop';
  for (const notch of THROTTLE_NOTCHES) {
    if (throttleSpeed(notch, stats.maxSpeed) <= stats.cavitationSpeed) quiet = notch;
  }
  return quiet;
}

/**
 * Whether a boat at this speed is cavitating — audible across the map (planning/03 §3).
 *
 * The depth term ("at 200 m; deeper water raises it", planning/05) is deliberately absent:
 * it belongs with the acoustic model, and guessing at it here would put a number on the HUD
 * that the sim later disagrees with.
 */
export function isCavitating(speed: number, stats: Stats): boolean {
  return speed > stats.cavitationSpeed;
}

// ── Tubes ───────────────────────────────────────────────────────────────────────────

/**
 * `empty` is not "out of ammunition" — torpedoes are unlimited (planning/05 §4). It is the
 * state of a tube on a boat whose loading gear is gone, which nothing produces yet.
 */
export type TubeStatus = 'loaded' | 'reloading' | 'empty';

export interface TubeState {
  /** Position on the boat, 0-based. The pip order in the fleet list. */
  readonly index: number;
  /** The variant this tube carries, chosen at fleet-build time (Q6). */
  readonly weapon: WeaponId;
  readonly status: TubeStatus;
  /** Seconds until `reloading` becomes `loaded`. Zero in every other status. */
  readonly readyInSeconds: number;
}

// ── Standing orders ─────────────────────────────────────────────────────────────────

/**
 * What a boat is doing when nobody is looking at it (planning/04 §5).
 *
 * Two of the eventual set. `hold` is what a boat does with no order at all — it is the
 * deployment state, and the fleet list has to be able to say so. `transit` is the base
 * movement order and is here because it is the one every other order is described against.
 * Hug-the-layer, follow-the-bottom, station-keeping, patrol, and the weapon and sonar
 * postures arrive with the command interface (planning/08 §5).
 */
export type StandingOrder =
  { readonly kind: 'hold' } | { readonly kind: 'transit'; readonly to: Vec2 };

export const HOLDING: StandingOrder = { kind: 'hold' };

// ── Boats ───────────────────────────────────────────────────────────────────────────

export type BoatStatus = 'active' | 'destroyed';

/**
 * A boat's ground truth. **This shape never crosses the wire** — `match/view.ts` narrows it
 * per recipient, because the enemy's stat block is most of what sonar exists to make a player
 * work for (planning/01 §5, 06 §3).
 *
 * Split into a static half and a volatile half by convention rather than by type: everything
 * above `pos` is fixed for the match and travels once in `MatchSetup`; everything from `pos`
 * down changes and travels in view frames. Keeping them in one object means the server reads
 * one record per boat instead of joining two.
 */
export interface BoatState {
  readonly id: EntityId;
  readonly team: TeamId;
  /** The account that commands it. Boats belong to a player, not to a team pool. */
  readonly owner: string;
  /** Position within its owner's fleet, 0-based — the fleet list's fixed order (08 §5). */
  readonly index: number;
  /** Player-chosen at fleet-build time; drawn on the scope, so it is short. */
  readonly name: string;
  readonly hull: HullId;
  /** Resolved through the fitted modules. What the boat actually has. */
  readonly stats: Stats;
  /** Fleet points this boat cost. The unit deathmatch scoring counts in (planning/06 §2.1). */
  readonly cost: number;

  readonly pos: Vec2;
  /** Degrees, `0` along `+x`, positive counter-clockwise. */
  readonly facing: number;
  /** m/s along `facing`, always ≥ 0 — there is no reverse (planning/04 §4). */
  readonly speed: number;
  readonly throttle: ThrottleNotch;
  readonly hp: number;
  readonly tubes: readonly TubeState[];
  readonly order: StandingOrder;
  readonly status: BoatStatus;
}

/**
 * Below this fraction of maximum hit points a boat is "damaged": permanently louder and
 * slower (planning/04 §8), and worth half its points on the deathmatch timer (06 §2.1).
 *
 * One number for both because they describe the same thing — a boat that is no longer a
 * whole boat — and two would eventually differ by a percentage point nobody meant.
 */
export const DAMAGED_HP_FRACTION = 0.5;

export function isDamaged(boat: { hp: number; stats: Stats }): boolean {
  return boat.hp < boat.stats.maxHp * DAMAGED_HP_FRACTION;
}

/**
 * What a boat is worth to its team's surviving-points total: nothing when destroyed, half
 * when damaged, full otherwise (planning/06 §2.1).
 */
export function survivingValue(boat: BoatState): number {
  if (boat.status === 'destroyed') return 0;
  return isDamaged(boat) ? boat.cost / 2 : boat.cost;
}
