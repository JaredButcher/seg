/**
 * ╔═══════════════════════════════════════════════════════════════════════════════════╗
 * ║  WEAPON TABLE — tuning data. Edit the numbers here; nothing else needs touching.   ║
 * ╚═══════════════════════════════════════════════════════════════════════════════════╝
 *
 * The tube variants from planning/05 §4, transcribed, plus the run-out numbers the
 * weapons phase reads (`sim/weapons`). Like hulls and modules this file is data with no
 * behaviour: the kinematics, the seeker, and the fuze live next door and read these.
 *
 * **Torpedoes are unlimited** (05 §4). The constraints are tube count, reload time, and the
 * noise of firing — which is why there is no ammunition count anywhere in the data model. A
 * tube is loaded, reloading, unloading, or destroyed with its boat; it never runs out.
 *
 * ## What is firable today
 *
 * Four of the five: two weapons that go bang and two that do not. `deployable` says so per row
 * rather than a list somewhere else, so the fire path, the tube picker, and the fleet editor all
 * refuse the same load for the same reason. Only the mine is left, and it is left because a
 * proximity fuze that waits ten minutes is a behaviour the run-out does not have.
 *
 * ## Every load leaves the tube the same way
 *
 * A weapon spends its first seconds in a **launch phase** (`match/torpedo.ts#TorpedoPhase`):
 * slow, turning onto the bearing of the point it was sent to, and — if that point is behind it —
 * braking to a stop and mirroring, exactly as a submarine reverses (`match/movement.ts`). Only
 * when it is pointing where it is going does it wind up to its running speed.
 *
 * That is a tax on a bad shot rather than a new decision. An over-the-shoulder launch already
 * cost the shooter the turn (`sim/weapons/launch.ts` fires a weapon on the *boat's* heading);
 * now it also costs the seconds spent getting round, and every listener in the water gets those
 * seconds too — a weapon at a third of its speed is a weapon at a third of its motor noise.
 *
 * ## The two that go bang, and how they differ
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
 *
 * ## The two that do not
 *
 * Both are fired the same way at the same kind of point, and both are about the *picture* rather
 * than about hit points:
 *
 * - **The drone** runs to the point, stops, and works: a loud pulse every two seconds and a
 *   better hydrophone than any hull carries, listening from somewhere that is not you. It is the
 *   only thing in the game that adds to a team's vision without adding a boat to the water, and
 *   it is the answer to "I want to know what is round that corner without going round it".
 * - **The active decoy** runs on at the flank speed of the boat that fired it, radiating that
 *   boat's noise off that boat's silhouette. A listener who confirms it confirms a *submarine* —
 *   the full profile, on the scope and on the mini-map — because at the level of squares and
 *   decibels that is genuinely what is there (`sim/acoustics/torpedoes.ts`).
 *
 * The decoy's counter is the loudest thing a player can do: **ping it**. A pulse measures a
 * seven-metre object where the passive picture promised a hundred-metre one, the contact is
 * reclassified in front of the player who was chasing it (`sim/weapons/decoy.ts`), and the price
 * of finding out is that everyone now knows where the listener is.
 */

/** Which of the three jobs a tube's load does. Drives the fleet list's tube glyph. */
export type WeaponRole = 'torpedo' | 'utility' | 'mine';

/** What the weapon's own sensor does, if it has one. */
export type WeaponSeeker = 'none' | 'passive' | 'active' | 'switchable';

/**
 * What a load does once it has **arrived** — the one field the weapons phase branches on.
 *
 * A single discriminator rather than a handful of booleans (`homes`, `loiters`, `pretends`),
 * because the four are mutually exclusive by construction: a weapon cannot both hold station and
 * run on, and a pair of flags that can express that contradiction is a pair of flags something
 * will eventually set that way.
 *
 * ```
 * seeker   wake the sonar and hunt what it hears        standard
 * inert    nothing at all; hold the course it is on     super-cavitating
 * loiter   take the way off and work from there         drone, mine
 * decoy    run on, sounding like the boat that fired    active decoy
 * ```
 */
export type WeaponBehaviour = 'seeker' | 'inert' | 'loiter' | 'decoy';

export type WeaponId = 'standard' | 'super-cavitating' | 'active-decoy' | 'drone' | 'mine';

/**
 * A weapon's own ears, or `null` for the ones that have none — which is everything except the
 * drone.
 *
 * The same two numbers a hull's sonar is described by, and deliberately the same shape the
 * solver's `Hydrophone` takes (`sim/acoustics/solve.ts`), so a listening weapon reaches the
 * solve as an ordinary listener and its team's picture grows from where it is sitting.
 *
 * **This is not a seeker.** A seeker is a weapon deciding where to steer and it tells its team
 * nothing (`sim/weapons/seeker.ts` opens by saying why). This is a weapon *listening on behalf
 * of its team*, which is the drone's whole job and the reason it is the only load that has one.
 */
export interface WeaponHydrophone {
  /** Array gain, dB. The drone's beats every hull in the table — it is a purpose-built ear. */
  readonly gain: number;
  /**
   * Its own machinery as its own hydrophone hears it, dB, **at rest**.
   *
   * Under way it is worse, by the same quadratic a boat pays (`selfNoiseOf`), which is what
   * makes a drone that has arrived and stopped a far better listener than one still in transit.
   */
  readonly selfNoise: number;
}

export interface WeaponDef {
  readonly id: WeaponId;
  readonly name: string;
  /** Two or three characters, for the tube pips in the fleet list. */
  readonly abbreviation: string;
  readonly role: WeaponRole;
  /** What it does once it reaches the point it was sent to. */
  readonly behaviour: WeaponBehaviour;
  /** Fleet points, per tube loaded with this variant. */
  readonly cost: number;
  /**
   * m/s in the water, once it is up to speed.
   *
   * A `decoy` ignores this and runs at the flank speed of the boat that fired it
   * (`match/torpedo.ts#topSpeed`); the number here is what the picker displays and the fallback
   * for a decoy with nobody to imitate.
   */
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
   * How loud this weapon's own active pulse is, dB, or `0` for one that never pings.
   *
   * A standard torpedo's is weak on purpose — a boat pings at 108–124 dB and this is 95, which
   * with `SEEKER_SELF_NOISE` puts acquisition at roughly three hundred metres. The player is
   * aiming a short-sighted weapon at a point in the water, not designating a target.
   *
   * The drone's is the other extreme and for the opposite reason: it is a sonar that happens to
   * be shaped like a torpedo, so it pings harder than a Heavy and is heard accordingly.
   */
  readonly seekerPingLevel: number;
  /**
   * Milliseconds between pulses once it is working, or `0` for a weapon that never pings.
   *
   * Per weapon rather than one constant because the two that ping are doing different jobs at
   * different rates: a seeker re-aims a warhead and wants the fastest rhythm it can afford,
   * while a drone is imaging and pulses on the same two-second cycle a boat does.
   */
  readonly pingIntervalMs: number;
  /** Its own ears, or `null`. See `WeaponHydrophone` — the drone is the only load with any. */
  readonly hydrophone: WeaponHydrophone | null;
}

export const WEAPONS: Readonly<Record<WeaponId, WeaponDef>> = {
  standard: {
    id: 'standard',
    name: 'Standard Torpedo',
    abbreviation: 'STD',
    role: 'torpedo',
    behaviour: 'seeker',
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
    pingIntervalMs: 1000,
    hydrophone: null,
  },
  'super-cavitating': {
    id: 'super-cavitating',
    name: 'Super-cavitating Torpedo',
    abbreviation: 'SCV',
    role: 'torpedo',
    behaviour: 'inert',
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
    pingIntervalMs: 0,
    hydrophone: null,
  },
  'active-decoy': {
    id: 'active-decoy',
    name: 'Active Decoy',
    abbreviation: 'DCY',
    role: 'utility',
    behaviour: 'decoy',
    cost: 15,
    // Both of these are display numbers for a weapon that takes its speed from whoever fired it
    // (see `speed` on the interface). The range is written to be slack against the lifetime: two
    // minutes at the fastest flank in the hull table is 1800 m, so the clock is what ends a
    // decoy's run and a fast boat's decoy does not quietly get a shorter one.
    speed: 15,
    range: 2400,
    maxPitch: 30,
    seeker: 'none',
    damage: 0,
    description:
      'Runs on at your own flank speed, radiating your own noise off your own silhouette — ' +
      'a second contact of you, confirmed as a boat. An active pulse sees through it.',
    deployable: true,
    lifetimeSeconds: 120,
    turnRate: 15,
    // The fallback for a decoy with nobody to imitate, which a tube cannot produce. A real one
    // radiates the launching boat's source level instead (`sim/acoustics/torpedoes.ts`).
    sourceLevel: 45,
    damageRadius: 0,
    seekerPingLevel: 0,
    pingIntervalMs: 0,
    hydrophone: null,
  },
  drone: {
    id: 'drone',
    name: 'Sonar Drone',
    abbreviation: 'DRN',
    role: 'utility',
    behaviour: 'loiter',
    cost: 20,
    speed: 12,
    range: 2000,
    maxPitch: 40,
    seeker: 'active',
    damage: 0,
    description:
      'Swims to a point, stops, and works: a pulse harder than a Heavy every two seconds and ' +
      'ears better than any hull. Five minutes of seeing round a corner you are not in.',
    deployable: true,
    lifetimeSeconds: 300,
    turnRate: 20,
    // Quiet in transit — a scout that announced itself on the way to its station would never
    // reach one. Scaled by speed like every weapon's motor, so a drone on station is silent.
    sourceLevel: 40,
    damageRadius: 0,
    // Louder than a Heavy's 124, because that is the entire proposition: it is a sonar first and
    // a weapon not at all, and what it buys is paid for by being the easiest thing on the map to
    // find. Killing one is a torpedo well spent.
    seekerPingLevel: 126,
    pingIntervalMs: 2000,
    // Better than the Scout's 6 dB of array gain and quieter at rest than a stopped submarine's
    // −6: no reactor, no crew, and nothing to do but listen. This is planning/05 §4's "sensitive
    // hydrophones and good filters" as the only two numbers the model has for saying it.
    hydrophone: { gain: 12, selfNoise: -14 },
  },
  mine: {
    id: 'mine',
    name: 'Mine',
    abbreviation: 'MNE',
    role: 'mine',
    behaviour: 'loiter',
    cost: 10,
    speed: 8,
    range: 800,
    maxPitch: 45,
    seeker: 'passive',
    damage: 130,
    description:
      'Transits to a point, holds depth, and waits about ten minutes. Several at staggered ' +
      'depths make a vertical curtain across a chokepoint.',
    /*
     * The last unbuilt load, and `deployable: false` is not "unbalanced" — it is "unbuilt". A
     * mine needs a proximity fuze that waits ten minutes without arming on the boat that laid it,
     * and the run-out has no such thing. A tube may only be *loaded* with a load this is true
     * for, so a player is never left holding a weapon that will not fire.
     */
    deployable: false,
    lifetimeSeconds: 600,
    turnRate: 20,
    sourceLevel: 50,
    damageRadius: 30,
    seekerPingLevel: 0,
    pingIntervalMs: 0,
    hydrophone: null,
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
// differ and a copy per row is a row that gets missed on a tuning pass.

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

/**
 * m/s a weapon holds while it is still getting round onto its bearing.
 *
 * Slow enough to be a real cost — a third of a standard torpedo's cruise, and under a seventh of
 * a super-cavitating one's — and slow for three reasons at once. The turning circle is `v/ω`, so
 * a weapon that has to come about does it in about forty metres instead of three hundred; the
 * motor scales with speed, so the noisiest weapon in the game spends its first seconds quiet;
 * and the seconds themselves are the price of a shot taken over the shoulder.
 */
export const TORPEDO_LAUNCH_SPEED = 7;

/**
 * Degrees of heading error at which a weapon stops manoeuvring and opens the throttle.
 *
 * Measured against the **pitch-clamped** demand rather than the raw bearing to the aim point
 * (`sim/weapons/kinematics.ts#clampPitch`), which is what stops a super-cavitating weapon sent
 * at something directly above it from creeping at launch speed for its whole life waiting to
 * point at a heading its ±12° band will never let it hold.
 */
export const TORPEDO_LAUNCH_ALIGNMENT = 4;

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
