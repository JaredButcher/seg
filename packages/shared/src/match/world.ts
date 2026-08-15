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

import { TRANSIENTS, type TransientKind } from '../content/acoustics.js';
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
 * The throttle is notched, not continuous (planning/08 §5, 09 §9). Three notches — slow, full,
 * flank — each an *absolute* speed rather than a fraction of the boat's maximum, because "full"
 * is defined against the cavitation threshold (one knot under it) and fractions cannot express
 * that; the notch table can.
 *
 * Notches rather than a slider because the control has to be readable at a glance across a
 * ten-row fleet list and settable with one key, and because the interesting question is never
 * "8.4 or 8.6 m/s" — it is "am I above the cavitation line". A notch is a decision; a slider
 * is a fidget.
 */
export const THROTTLE_NOTCHES = ['slow', 'full', 'flank'] as const;
export type ThrottleNotch = (typeof THROTTLE_NOTCHES)[number];

export function isThrottleNotch(value: unknown): value is ThrottleNotch {
  return typeof value === 'string' && (THROTTLE_NOTCHES as readonly string[]).includes(value);
}

/** One nautical mile per hour, in metres per second. The notch speeds are specced in knots. */
export const KNOTS_TO_MPS = 0.514444;

/** The slow notch, in knots. A quiet crawl, well under every hull's cavitation line. */
export const SLOW_SPEED_KNOTS = 5;

export const THROTTLE_LABELS: Readonly<Record<ThrottleNotch, string>> = {
  slow: 'SLOW',
  full: 'FULL',
  flank: 'FLANK',
};

/** The speed a notch demands of a given boat, m/s. */
export function throttleSpeedFor(stats: Stats, notch: ThrottleNotch): number {
  switch (notch) {
    case 'slow':
      return SLOW_SPEED_KNOTS * KNOTS_TO_MPS;
    case 'full':
      return stats.cavitationSpeed - KNOTS_TO_MPS;
    case 'flank':
      return stats.maxSpeed;
  }
}

/**
 * The highest notch that still stays under the cavitation threshold.
 *
 * This is the mark drawn on the throttle control (planning/08 §5) — the fastest a boat can go
 * without screaming. `full` is one knot under the threshold by construction, so it is always
 * this notch; the loop stays because the guarantee worth keeping is the *shape* ("the fastest
 * quiet notch"), in case the table changes.
 */
export function quietestLoudNotch(stats: Stats): ThrottleNotch {
  let quiet: ThrottleNotch = 'slow';
  for (const notch of THROTTLE_NOTCHES) {
    if (throttleSpeedFor(stats, notch) <= stats.cavitationSpeed) quiet = notch;
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
 *
 * `unloading` is the first half of a change of mind: a tube holding a weapon the player no
 * longer wants has to get it *out* before the other one goes in, and that takes time the player
 * can be punished for. It always runs straight into `reloading`, never back to `loaded` — see
 * `match/tubes.ts`.
 */
export type TubeStatus = 'loaded' | 'reloading' | 'unloading' | 'empty';

export interface TubeState {
  /** Position on the boat, 0-based. The pip order in the fleet list. */
  readonly index: number;
  /**
   * The variant in the tube right now, or — while it is `reloading` — the one on its way in.
   *
   * One field rather than two, because "what is coming" and "what is here" are never both
   * interesting: a reloading tube cannot fire, so the only question about it is what it will be
   * when it can. The fleet list draws the same glyph dimmed.
   */
  readonly weapon: WeaponId;
  /**
   * What the *next* load will be, chosen in battle from the tube picker (planning/08 §5).
   *
   * Reloading begins the instant a tube fires, so a player who waits until the tube is empty to
   * decide has already missed the decision. Choosing it up front is the whole mechanic: the
   * question is not "what do I fire" but "what do I want to be holding in forty seconds".
   */
  readonly next: WeaponId;
  readonly status: TubeStatus;
  /** Seconds until this status ends. Zero when `loaded` or `empty`. */
  readonly readyInSeconds: number;
}

// ── The countermeasure launcher ─────────────────────────────────────────────────────

/**
 * The one slot on a boat that is not a tube: the noisemaker launcher (`content/weapons.ts`).
 *
 * **One per hull, on every hull, always.** It is not fitted, not bought, and not chosen — which is
 * why it is a field on the boat rather than another entry in `tubes`. A tube is a decision at three
 * levels (what is in it, what goes in next, which one fires), and this is a decision at none: there
 * is exactly one thing it can hold and exactly one thing you can do with it. Folding it into
 * `tubes` would have given every hull a phantom extra tube that the picker had to refuse, the
 * salvo had to skip, and the fleet list had to draw differently anyway.
 *
 * ## Two states, because there is nothing to unload
 *
 * A tube has four (`TubeStatus`) and three of them exist to describe changing your mind — a load
 * arriving, a load being ejected, a boat whose gear is gone. None of those can happen here. The
 * launcher is `ready` or it is `reloading`, and the only event that moves it is the player pressing
 * the key (`match/tubes.ts#dropped`).
 *
 * ## And it reloads on its own clock
 *
 * `countermeasureReloadSecondsFor(stats)` (`match/tubes.ts`), off `content/stats.ts`'s
 * `countermeasureReloadSeconds` rather than a tube's `reloadSeconds` — a hull's own figure, fitted
 * modules and all, the same way `reloadSeconds` is. Rapid Loader leaves it alone; Countermeasure
 * Reloader (`content/modules.ts`) is the module that speeds up specifically this.
 */
export type CountermeasureStatus = 'ready' | 'reloading';

export interface CountermeasureState {
  readonly status: CountermeasureStatus;
  /** Seconds until it is ready again. Zero when it already is. */
  readonly readyInSeconds: number;
}

// ── Standing orders ─────────────────────────────────────────────────────────────────

/**
 * What a boat is doing when nobody is looking at it (planning/04 §5).
 *
 * Two of the eventual set. `hold` is what a boat does with no order at all — it is the
 * deployment state, and the fleet list has to be able to say so. `transit` is the base
 * movement order and is here because it is the one every other order is described against:
 * it carries the ordered list of waypoints, the last of which is where the boat is headed
 * and the ones before it the route it will pass through to get there (shift-click queues).
 * Hug-the-layer, follow-the-bottom, station-keeping, patrol, and the weapon and sonar
 * postures arrive with the command interface (planning/08 §5).
 */
export type StandingOrder =
  { readonly kind: 'hold' } | { readonly kind: 'transit'; readonly waypoints: readonly Vec2[] };

export const HOLDING: StandingOrder = { kind: 'hold' };

// ── Transients ──────────────────────────────────────────────────────────────────────

/**
 * A noise event a boat has made and is still ringing with (planning/03 §3).
 *
 * A *kind and a tick*, not a level: the level of a transient is a pure function of how long ago
 * it fired (`content/acoustics.ts#transientLevel`), so storing the level would be storing a
 * derived number that the very next tick disagrees with. The same reasoning as `lastPingTick`,
 * and for the same reason it is a tick rather than a timestamp — the simulation's only clock is
 * the tick count (planning/02 §5).
 *
 * Kept on the boat rather than in a list beside the runtime so that it survives the state
 * replacement every mutation in this codebase is made by, and so a view frame can carry it: the
 * client hears its own fleet's bangs by reading them off the wire, which is the same door the
 * acoustic model reads them through.
 */
export interface BoatTransient {
  readonly kind: TransientKind;
  /** The simulation tick it fired on. */
  readonly tick: number;
}

/** Whether a transient fired at `firedTick` is still ringing at `tick`. */
export function isRinging(transient: BoatTransient, tick: number, tickHz: number): boolean {
  return (tick - transient.tick) / tickHz < TRANSIENTS[transient.kind].seconds;
}

/**
 * Anything in the water that can make a noise and remember it.
 *
 * Generic rather than `BoatState` because a torpedo rings too — its launch, its seeker's pulse,
 * and the bang it ends on (`match/torpedo.ts`) — and a second copy of these two functions is how
 * a boat's bangs and a weapon's bangs end up decaying by different rules.
 */
export interface Ringing {
  readonly transients: readonly BoatTransient[];
}

/**
 * Drop whatever has rung down into the ambient. Returns the *same object* when nothing has, so a
 * fleet making no noise — which is most of them, most of the time — allocates nothing.
 *
 * Pruning is hygiene rather than correctness: `transientLevel` already returns `-Infinity` past
 * a transient's life, so a stale entry is acoustically silent. What it stops is the list growing
 * for the length of a match, and a view frame carrying a bang from twenty minutes ago.
 */
export function pruneTransients<T extends Ringing>(entity: T, tick: number, tickHz: number): T {
  if (entity.transients.length === 0) return entity;
  const ringing = entity.transients.filter((transient) => isRinging(transient, tick, tickHz));
  if (ringing.length === entity.transients.length) return entity;
  return { ...entity, transients: ringing };
}

/**
 * Sound one transient, pruning what has finished on the way through.
 *
 * A second transient of the same kind on the same tick is *not* added twice — a boat that
 * scrapes two walls in one 50 ms step made one noise, not two, and power-summing the same bang
 * with itself would put 3 dB on the map that nothing in the world produced. The same rule is
 * what makes a four-tube salvo one launch transient rather than four.
 */
export function withTransient<T extends Ringing>(
  entity: T,
  kind: TransientKind,
  tick: number,
  tickHz: number,
): T {
  const pruned = pruneTransients(entity, tick, tickHz);
  if (pruned.transients.some((t) => t.kind === kind && t.tick === tick)) return pruned;
  return { ...pruned, transients: [...pruned.transients, { kind, tick }] };
}

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
  /**
   * Base torpedo `WeaponId` → the improved variant an "Improved" module fits it with
   * (`content/weapons.ts#WeaponDef.upgradeOf`), empty for a boat with none fitted.
   *
   * Resolved once at deployment (`fleet/resolve.ts#resolveBoat`, `match/deploy.ts`) rather than
   * derived from fitted modules at load time, because nothing downstream of deployment — the tube
   * picker, the server's `load()` gate — has or wants the fleet-build `FittedModule[]` a
   * `ModuleId` would need resolving again. `content/weapons.ts#tubeWeaponIdsFor` is what reads
   * this to turn `TUBE_WEAPON_IDS` into what this boat's picker actually offers.
   */
  readonly weaponSubstitutions: Readonly<Partial<Record<WeaponId, WeaponId>>>;

  readonly pos: Vec2;
  /** Degrees, `0` along `+x`, positive counter-clockwise. */
  readonly facing: number;
  /** m/s along `facing`, always ≥ 0 — there is no reverse (planning/04 §4). */
  readonly speed: number;
  readonly throttle: ThrottleNotch;
  readonly hp: number;
  readonly tubes: readonly TubeState[];
  /**
   * The noisemaker launcher. Every boat has one and no boat has two — see `CountermeasureState`.
   *
   * Beside `tubes` rather than in it, and a single object rather than an array, because that is
   * the shape of the thing: the count is a constant of the game, not of the hull.
   */
  readonly countermeasure: CountermeasureState;
  readonly order: StandingOrder;
  readonly status: BoatStatus;

  /**
   * Whether active sonar is switched on (planning/03 §3).
   *
   * A posture rather than an action: the player throws a switch and the boat pulses on a fixed
   * interval until it is thrown back. There is no "ping once", deliberately — the decision the
   * game is interested in is *whether to be pinging at all*, and a single-shot button would let
   * a player take the range and pay almost nothing for it.
   */
  readonly activeSonar: boolean;
  /**
   * The simulation tick of this boat's last pulse. Zero before it has ever pinged.
   *
   * Kept on the boat rather than in a timer beside the runtime for two reasons. It survives a
   * state replacement, which is how every mutation in this codebase is made; and it makes the
   * interval enforceable — the next pulse is due `ticksPerPing` after this one whatever the
   * player does with the switch in between, so flicking it cannot outrun the rhythm.
   */
  readonly lastPingTick: number;

  /**
   * The noise events still ringing on this boat (planning/03 §3).
   *
   * Empty almost always: a transient is a *bang*, and boats spend most of a match not banging.
   * The acoustic model power-sums whatever is in here into the boat's source level
   * (`sim/acoustics/boats.ts#emittedLevels`), and the client plays a cue for each new one — one
   * event, both consequences, which is what stops the sound a player hears and the sound the
   * enemy's sonar hears from being two different facts.
   *
   * The active pulse is deliberately *not* in here even though it is also a transient: its
   * timing is a rhythm rather than an event (`lastPingTick`), so it is derived rather than
   * recorded. See ADR 0003.
   */
  readonly transients: readonly BoatTransient[];
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

// ── Wrecks ──────────────────────────────────────────────────────────────────────────

/**
 * How fast a wreck sinks, straight down, m/s (planning/04 §8, revised).
 *
 * Roughly the slow notch's own speed (`SLOW_SPEED_KNOTS`) — a hull with nobody driving it does
 * not fall like a stone, and "slowly" is the whole of the effect this is meant to read as. It
 * ignores terrain rather than settling on it (`sim/collision/hulls.ts#hullsTouch` already keeps
 * a wreck out of hull collision, and `sim/collision/phase.ts` skips it for rock too): a
 * terrain-aware descent is a real feature and this is not it, and the map's y-up frame already
 * gives "leaves the map" an honest meaning without one — `y = 0` is the seabed on every map size
 * (`map/sizes.ts`), so sinking through it is sinking out of the world, and `wreckHasLeftMap`
 * below is where the descent stops mattering.
 *
 * Tuned so a wreck from early in a match has a real chance of despawning before the 30-minute
 * clock runs out on a Medium map, and a Large map's taller field will often outlast one — a
 * battlefield that eventually clears rather than a permanent one (Q24, revised).
 */
export const WRECK_SINK_SPEED = 3;

/**
 * Whether a wreck has sunk out of the world entirely and should stop existing as a thing in it:
 * no longer a reflector, no longer a seeker's target, no longer drawn (`match/view.ts#WreckView`,
 * `sim/acoustics/boats.ts`, `sim/weapons/seeker.ts`).
 *
 * `pos.y < 0` is the whole test, and it is sufficient on its own: a live boat can never reach a
 * negative `y` (the map's edge is solid to ordinary collision, `sim/collision/terrain.ts`), so
 * the condition can only ever become true for a boat this file has already sunk past the seabed.
 *
 * What it deliberately does not do is delete the boat from `MatchState.boats`. The record is kept
 * for the rest of the match — a team's `boatsTotal` and the results screen's Reveal both read the
 * whole fleet a side ever fielded, and a roster that shrank as wrecks cleared the map would get
 * both of those wrong.
 */
export function wreckHasLeftMap(boat: Pick<BoatState, 'status' | 'pos'>): boolean {
  return boat.status === 'destroyed' && boat.pos.y < 0;
}
