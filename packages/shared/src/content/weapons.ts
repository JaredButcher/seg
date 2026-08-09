/**
 * ╔═══════════════════════════════════════════════════════════════════════════════════╗
 * ║  WEAPON TABLE — tuning data. Edit the numbers here; nothing else needs touching.   ║
 * ╚═══════════════════════════════════════════════════════════════════════════════════╝
 *
 * The six tube variants from planning/05 §4, transcribed, plus the run-out numbers the
 * weapons phase reads (`sim/weapons`). Like hulls and modules this file is data with no
 * behaviour: the kinematics, the seeker, and the fuze live next door and read these.
 *
 * **Torpedoes are unlimited** (05 §4). The constraints are tube count, reload time, and the
 * noise of firing — which is why there is no ammunition count anywhere in the data model. A
 * tube is loaded, reloading, unloading, or destroyed with its boat; it never runs out.
 *
 * ## What is firable today
 *
 * Two of the six: `standard` and `super-cavitating`. `deployable` says so per row rather than a
 * list somewhere else, so the fire path, the tube picker, and the fleet editor all refuse the
 * same four loads for the same reason. The other four are drones, a decoy, and a mine — they
 * are *loiter* weapons, and every one of them needs a behaviour the run-out does not have.
 *
 * ## The two that are built, and how they differ
 *
 * The whole shape of the pair is that **neither one is aimed at a boat**. A player clicks a
 * point in the water and the weapon runs to it, so both demand a lead — the difference is what
 * happens when the weapon gets there:
 *
 * - **Standard** switches its seeker on at that point and starts pinging. So the click is an
 *   *enable point* (planning/04 §7 step 2) and the skill is putting it ahead of where the target
 *   will be, close enough that the target is inside `seekerRange` when the sonar wakes up.
 * - **Super-cavitating** does nothing at all when it gets there; it keeps going until it hits
 *   something or times out. The click is a pure aim point and the skill is the lead itself. It
 *   is three times the speed, so the lead is a third of the distance — which is the entire
 *   reason to carry one.
 *
 * planning/05 §4 gives super-cavitating an "active only" seeker. It has none here, by design
 * decision: a weapon that is both the fastest in the game *and* self-guiding leaves the standard
 * torpedo with no role, and "unavoidable inside 800 m, useless as a long shot" is a description
 * of an unguided sprint rather than of a homing weapon. Its narrow pitch band is still its
 * designed counter — it cannot follow a target that dives.
 */

/** Which of the three jobs a tube's load does. Drives the fleet list's tube glyph. */
export type WeaponRole = 'torpedo' | 'utility' | 'mine';

/** What the weapon's own sensor does, if it has one. */
export type WeaponSeeker = 'none' | 'passive' | 'active' | 'switchable';

export type WeaponId =
  | 'standard'
  | 'super-cavitating'
  | 'active-decoy'
  | 'active-sonar-drone'
  | 'passive-sonar-drone'
  | 'mine';

export interface WeaponDef {
  readonly id: WeaponId;
  readonly name: string;
  /** Two or three characters, for the tube pips in the fleet list. */
  readonly abbreviation: string;
  readonly role: WeaponRole;
  /** Fleet points, per tube loaded with this variant. */
  readonly cost: number;
  /** m/s in the water. */
  readonly speed: number;
  /** Metres before fuel is exhausted. */
  readonly range: number;
  /** Degrees either side of horizontal. The balance dimension the slice adds (05 §4). */
  readonly maxPitch: number;
  readonly seeker: WeaponSeeker;
  /** Hit points removed at the centre of the detonation. Zero for the utility loads. */
  readonly damage: number;
  /** One line in the picker. Say the trade, not just the benefit. */
  readonly description: string;

  // ── Run-out (planning/04 §7) ──────────────────────────────────────────────────
  /**
   * Whether the weapons phase can actually put one in the water.
   *
   * `false` is not "unbalanced", it is "unbuilt": the four loiter loads need a behaviour after
   * they arrive — pretend to be a boat, ping on a timer, listen, wait for a proximity fuze —
   * and none of those exist. A tube may still be *loaded* with one from the picker only if this
   * is true, so a player is never left holding a weapon that will not fire.
   */
  readonly deployable: boolean;
  /**
   * Seconds before it scuttles itself, whether or not it has hit anything.
   *
   * Roughly `range / speed`, and deliberately written out rather than derived: those two are
   * *display* numbers on the picker and this is the one the simulation obeys, so tying them
   * would make a range tweak silently change how long a weapon lives.
   *
   * A timeout is a **detonation**, not a fizzle. A warhead that has run out of fuel is still a
   * warhead, it is loud, and a torpedo that expires beside your own boat is your own fault —
   * which is the same bargain friendly fire makes everywhere else (Q7).
   */
  readonly lifetimeSeconds: number;
  /**
   * Degrees per second. With the speed this is the turning circle: `r = v / ω`.
   *
   * The super-cavitating weapon's is deliberately brutal — 55 m/s at 10 °/s is a 315 m circle,
   * so it cannot be talked out of the line it left the tube on.
   */
  readonly turnRate: number;
  /** dB at the reference range while it runs. What makes an incoming weapon *audible*. */
  readonly sourceLevel: number;
  /** Metres from the burst at which damage has fallen to nothing. Linear in between. */
  readonly damageRadius: number;
  /**
   * How loud its seeker's pulse is, dB, or `0` for a weapon with no seeker.
   *
   * Weak on purpose — a boat pings at 108–124 dB and this is 95, which with `SEEKER_SELF_NOISE`
   * puts acquisition at roughly three hundred metres. The player is aiming a short-sighted
   * weapon at a point in the water, not designating a target.
   */
  readonly seekerPingLevel: number;
}

/**
 * Every unbuilt load's run-out numbers.
 *
 * Written once rather than four times because they all mean the same thing — *nothing here has
 * been designed yet* — and four copies of a placeholder is four places to forget.
 */
const NOT_DEPLOYABLE = {
  deployable: false,
  lifetimeSeconds: 60,
  turnRate: 20,
  sourceLevel: 50,
  damageRadius: 30,
  seekerPingLevel: 0,
} as const;

export const WEAPONS: Readonly<Record<WeaponId, WeaponDef>> = {
  standard: {
    id: 'standard',
    name: 'Standard Torpedo',
    abbreviation: 'STD',
    role: 'torpedo',
    cost: 0,
    speed: 22,
    range: 3000,
    maxPitch: 40,
    seeker: 'active',
    damage: 100,
    description:
      'Runs to the point you click, then wakes its sonar and hunts. Slow enough to evade, ' +
      'agile enough in depth to chase a diving target, and short-sighted — put the enable ' +
      'point ahead of him.',
    deployable: true,
    lifetimeSeconds: 135,
    turnRate: 25,
    sourceLevel: 62,
    damageRadius: 40,
    seekerPingLevel: 95,
  },
  'super-cavitating': {
    id: 'super-cavitating',
    name: 'Super-cavitating Torpedo',
    abbreviation: 'SCV',
    role: 'torpedo',
    cost: 25,
    speed: 55,
    range: 1200,
    maxPitch: 12,
    seeker: 'none',
    damage: 90,
    description:
      'Three times the speed and no sonar at all: it goes exactly where you point it and ' +
      'nowhere else. Nearly unavoidable inside 800 m, cannot follow a target that dives, and ' +
      'announces its firing point map-wide.',
    deployable: true,
    lifetimeSeconds: 24,
    turnRate: 10,
    sourceLevel: 92,
    damageRadius: 30,
    seekerPingLevel: 0,
  },
  'active-decoy': {
    id: 'active-decoy',
    name: 'Active Decoy',
    abbreviation: 'DCY',
    role: 'utility',
    cost: 15,
    speed: 12,
    range: 1000,
    maxPitch: 30,
    seeker: 'none',
    damage: 0,
    description:
      'Swims out, then sounds like a boat for 60 s. Creates a false track; seduces seekers.',
    ...NOT_DEPLOYABLE,
  },
  'active-sonar-drone': {
    id: 'active-sonar-drone',
    name: 'Active Sonar Drone',
    abbreviation: 'ASD',
    role: 'utility',
    cost: 20,
    speed: 12,
    range: 2000,
    maxPitch: 40,
    seeker: 'none',
    damage: 0,
    description:
      'Loiters and pings for about four minutes. Illuminates an area from somewhere that is not you.',
    ...NOT_DEPLOYABLE,
  },
  'passive-sonar-drone': {
    id: 'passive-sonar-drone',
    name: 'Passive Sonar Drone',
    abbreviation: 'PSD',
    role: 'utility',
    cost: 20,
    speed: 10,
    range: 2000,
    maxPitch: 40,
    seeker: 'none',
    damage: 0,
    description:
      'A silent listener at a chosen point and depth for about six minutes. The way to watch ' +
      'below the layer while you stay above it.',
    ...NOT_DEPLOYABLE,
  },
  mine: {
    id: 'mine',
    name: 'Mine',
    abbreviation: 'MNE',
    role: 'mine',
    cost: 10,
    speed: 8,
    range: 800,
    maxPitch: 45,
    seeker: 'passive',
    damage: 130,
    description:
      'Transits to a point, holds depth, and waits about ten minutes. Several at staggered ' +
      'depths make a vertical curtain across a chokepoint.',
    ...NOT_DEPLOYABLE,
  },
};

export const WEAPON_IDS: readonly WeaponId[] = Object.keys(WEAPONS) as WeaponId[];

/** The loads a tube can actually be told to fire today. The picker offers exactly these. */
export const DEPLOYABLE_WEAPON_IDS: readonly WeaponId[] = WEAPON_IDS.filter(
  (id) => WEAPONS[id].deployable,
);

/**
 * What every tube carries until the fleet editor lets a player choose per tube (Q6).
 *
 * It costs nothing, which is what makes it a safe default: a fleet's point total does not
 * change the day the choice appears.
 */
export const DEFAULT_WEAPON: WeaponId = 'standard';

// ── Shared run-out constants ────────────────────────────────────────────────────────
//
// One number each rather than one per variant, because nothing about the design wants them to
// differ and six copies of a number is six chances to tune five of them.

/**
 * How hard a torpedo accelerates out of the tube, m/s².
 *
 * Fast, like `MOVEMENT_ACCELERATION`, and for the same reason: the interesting part of a shot is
 * where it is aimed, not the two seconds it spends winding up. A super-cavitating weapon still
 * takes about two seconds to reach 55 m/s, which is enough for the launch transient to be the
 * thing a listener hears first.
 */
export const TORPEDO_ACCELERATION = 30;

/** Metres, bow to tail. Also the length of the outline the acoustic model reflects off. */
export const TORPEDO_LENGTH = 7;

/**
 * dB swallowed by one bounce off a torpedo — twelve worse than a bare hull.
 *
 * A seven-metre object is a poor reflector, and the consequence is the one the design wants:
 * **a torpedo is heard, not seen.** You find an incoming weapon by its own racket on the direct
 * path (`sim/acoustics/solve.ts`), which means going quiet to listen is what saves you, and a
 * super-cavitating weapon at 92 dB is audible about twice as far as a standard one.
 */
export const TORPEDO_ABSORPTION = 22;

/** Metres. Inside this of a hull the fuze fires without needing contact. */
export const TORPEDO_PROXIMITY_FUZE = 12;

/** Array gain of a torpedo's seeker, dB. Almost none — it is one transducer in a nose cone. */
export const SEEKER_GAIN = 2;

/**
 * What a running torpedo's own seeker has to hear over, dB.
 *
 * The single number that makes the seeker short-sighted, and the honest reason for it: the
 * hydrophone is bolted to the loudest thing in its own neighbourhood. Twenty decibels is
 * twenty-six above a stopped submarine's `selfNoiseAtRest`, and it costs the seeker about a
 * factor of four in range against a boat's own sonar.
 */
export const SEEKER_SELF_NOISE = 20;

/** Degrees either side of the nose the seeker can see. It looks where it is going. */
export const SEEKER_ARC = 60;

/** Milliseconds between seeker pulses once it is armed. Slower than a boat's, and weaker. */
export const SEEKER_INTERVAL_MS = 1000;

/**
 * Seconds a seeker chases the last place it heard something before giving up and running on.
 *
 * Not zero, because a target that slips between two pulses has not gone anywhere in one second,
 * and a weapon that straightened out the instant it lost contact would be defeated by a hull
 * aspect change. Not long either: a torpedo committed to a stale position is a torpedo the
 * player can watch sail past.
 */
export const SEEKER_HOLD_SECONDS = 6;

export function getWeapon(id: WeaponId): WeaponDef {
  return WEAPONS[id];
}

export function isWeaponId(value: unknown): value is WeaponId {
  return typeof value === 'string' && (WEAPON_IDS as readonly string[]).includes(value);
}

/** Whether this load is one the weapons phase can put in the water today. */
export function isDeployableWeapon(id: WeaponId): boolean {
  return WEAPONS[id].deployable;
}
