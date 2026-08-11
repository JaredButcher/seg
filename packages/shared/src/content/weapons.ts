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
 * slow, turning onto the bearing of the point it was sent to, whatever that bearing is. Only
 * when it is pointing where it is going, and has held that for
 * `TORPEDO_LAUNCH_SETTLE_SECONDS`, does it wind up to its running speed.
 *
 * A point *behind* it is turned onto like any other, and so is a point straight up. A weapon has
 * no pitch band and no reversal — the two went together, and both are gone
 * (`sim/weapons/kinematics.ts`).
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
 * of an unguided sprint rather than of a homing weapon. Its **turning circle** is its designed
 * counter: 55 m/s at 10 °/s is 315 m of it, so a target that changes course while the weapon is
 * on the way passes through a circle the weapon cannot leave. It used to have a second counter —
 * a narrow pitch band, so that diving beat it — and that one is gone; playtesting found being
 * unable to follow a target upward an un-fun mechanic rather than a dimension of play.
 *
 * ## The two that do not
 *
 * Both are fired the same way at the same kind of point, and both are about the *picture* rather
 * than about hit points:
 *
 * - **The drone** wakes at the point and runs on in a straight line, imaging as it goes: a loud
 *   pulse every two seconds and a better hydrophone than any hull carries. It is the only thing
 *   in the game that adds to a team's vision without adding a boat to the water, and what it
 *   draws is a *transect* — a corridor of ocean along the line it was sent down, charted at a
 *   walking pace by something that is not you and cannot be talked out of going.
 *
 *   It does not stop and it cannot be steered, which is the whole of the decision: the aim point
 *   says where it wakes up, and the bearing it wakes up on says everything it will ever see. A
 *   drone sent down a winding cave meets a wall and is gone.
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
 * What a load does about **steering** once it has arrived — the one field the weapons phase
 * branches on.
 *
 * A single discriminator rather than a handful of booleans (`homes`, `pretends`), because the
 * three are mutually exclusive by construction and a pair of flags that can express a
 * contradiction is a pair of flags something will eventually set that way.
 *
 * ```
 * seeker   hunt what its sonar hears                 standard
 * inert    nothing; hold the course it is on         super-cavitating, drone, mine
 * decoy    run on, sounding like the boat that fired active decoy
 * ```
 *
 * **Nothing here is about sensors.** A weapon pings if it has a transducer and listens if it has
 * a hydrophone, whatever this says — which is why the drone and the super-cavitating torpedo can
 * share `inert` while one of them is the loudest imaging platform in the game and the other is a
 * blind sprint. Arrival wakes the sensors for both; steering is the only thing that differs.
 */
export type WeaponBehaviour = 'seeker' | 'inert' | 'decoy';

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
  /**
   * The load's mark on the scope, in **unit icon space** — origin at the weapon's centre, `+x`
   * toward the nose, `+y` down, spanning `x = -0.5 … +0.5`. Authored in `assets/weapons/*.svg`
   * and copied here vertex for vertex, exactly as a hull's is.
   *
   * **It is not a scale drawing and it is not the acoustic reflector.** A weapon reflects sound
   * off `match/torpedo.ts#torpedoOutline`, a flat seven-metre sliver that is deliberately cruder
   * than any of these — at `VISION_CELL_SIZE` a real polygon rasterizes to the same three
   * squares, so detail there would cost the solver time and buy nothing. These exist for the one
   * job the sliver cannot do: telling a player which of four things is in the water.
   *
   * Unit-length rather than metres because the two consumers draw it at wildly different sizes
   * and neither of them is seven metres. A friendly weapon is drawn at a floor size in screen
   * pixels (`client/render/ScopeHost.tsx#drawWeapons`) and a confirmed hostile at forty map
   * metres (`client/render/sonar.ts#CONTACT_DART_M`), so the shape is authored once at length
   * `1` and each caller multiplies. The beam is exaggerated to 5:1 for the same reason the dart
   * these replaced was: a true 12:1 torpedo beside a 170 m hull is a hairline.
   *
   * **The tip carries the classification.** Sharp triangle for the two loads that go bang,
   * rounded for the two that do not — a reading that has to survive being three pixels tall, so
   * nothing else on the shape is asked to carry it.
   */
  readonly silhouette: readonly (readonly [number, number])[];
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
    // Sharp tip, straight flared tail — assets/weapons/standard-dart.svg
    silhouette: [
      [0.5, 0.0],
      [0.15, -0.1],
      [-0.28, -0.1],
      [-0.34, -0.19],
      [-0.44, -0.19],
      [-0.5, -0.07],
      [-0.5, 0.07],
      [-0.44, 0.19],
      [-0.34, 0.19],
      [-0.28, 0.1],
      [0.15, 0.1],
    ],
    role: 'torpedo',
    behaviour: 'seeker',
    cost: 0,
    speed: 22,
    range: 3000,
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
    // Sharp tip, swept notched fins — assets/weapons/supercavitating-needle.svg
    silhouette: [
      [0.5, 0.0],
      [-0.05, -0.09],
      [-0.3, -0.09],
      [-0.5, -0.22],
      [-0.42, -0.06],
      [-0.42, 0.06],
      [-0.5, 0.22],
      [-0.3, 0.09],
      [-0.05, 0.09],
    ],
    role: 'torpedo',
    behaviour: 'inert',
    cost: 25,
    speed: 55,
    range: 1200,
    seeker: 'none',
    damage: 90,
    description:
      'Three times the speed and no sonar at all: it goes exactly where you point it and ' +
      'nowhere else. Nearly unavoidable inside 800 m, cannot be talked out of its line, and ' +
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
    // Rounded tip, wide transducer skirt — assets/weapons/decoy-blunt.svg
    silhouette: [
      [0.5, 0.0],
      [0.484, -0.06],
      [0.44, -0.104],
      [0.38, -0.12],
      [-0.3, -0.12],
      [-0.36, -0.2],
      [-0.5, -0.2],
      [-0.5, 0.2],
      [-0.36, 0.2],
      [-0.3, 0.12],
      [0.38, 0.12],
      [0.44, 0.104],
      [0.484, 0.06],
    ],
    role: 'utility',
    behaviour: 'decoy',
    cost: 15,
    // Both of these are display numbers for a weapon that takes its speed from whoever fired it
    // (see `speed` on the interface). The range is written to be slack against the lifetime: two
    // minutes at the fastest flank in the hull table is 1800 m, so the clock is what ends a
    // decoy's run and a fast boat's decoy does not quietly get a shorter one.
    speed: 15,
    range: 2400,
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
    // Rounded tip, sensor dome on its back — assets/weapons/drone-dome.svg. The only
    // asymmetric icon of the four, which is why placement mirrors rather than rotates.
    silhouette: [
      [0.5, 0.0],
      [0.484, -0.06],
      [0.44, -0.104],
      [0.38, -0.12],
      [0.12, -0.12],
      [0.08, -0.23],
      [-0.08, -0.23],
      [-0.12, -0.12],
      [-0.4, -0.12],
      [-0.5, -0.06],
      [-0.5, 0.06],
      [-0.4, 0.12],
      [-0.12, 0.12],
      [0.12, 0.12],
      [0.38, 0.12],
      [0.44, 0.104],
      [0.484, 0.06],
    ],
    role: 'utility',
    behaviour: 'inert',
    cost: 20,
    // Five minutes of straight line at 12 m/s is 3.6 km, which is most of the long axis of a
    // small map. The two numbers are written to end the run at the same moment on open water, so
    // a player reading the picker gets one answer to "how far will it get" rather than two.
    speed: 12,
    range: 3600,
    seeker: 'active',
    damage: 0,
    description:
      'Wakes at the point you send it to and runs on, imaging: a pulse harder than a Heavy ' +
      'every two seconds and ears better than any hull. It cannot be steered and it cannot stop.',
    deployable: true,
    lifetimeSeconds: 300,
    turnRate: 20,
    // Quiet in transit — a scout that announced itself on the way out would never get anywhere
    // useful. Its own pulse gives that away soon enough, and only from the point it wakes up at.
    sourceLevel: 40,
    damageRadius: 0,
    // Louder than a Heavy's 124, because that is the entire proposition: it is a sonar first and
    // a weapon not at all, and what it buys is paid for by being the easiest thing on the map to
    // find. Killing one is a torpedo well spent.
    seekerPingLevel: 126,
    pingIntervalMs: 2000,
    // Twice the Scout's array gain, and a self-noise a little better than a *stopped* submarine's
    // −6 while doing 12 knots' worth of metres per second. That is planning/05 §4's "sensitive
    // hydrophones and good filters" in the only two numbers the model has for saying it — and the
    // filters are the half that matters, because a drone is never not under way.
    hydrophone: { gain: 12, selfNoise: -10 },
  },
  mine: {
    id: 'mine',
    name: 'Mine',
    abbreviation: 'MNE',
    /*
     * The one load with no file in `assets/weapons/`, because it is the one load nothing can put
     * in the water (`deployable`, below). A rounded capsule, blunt at both ends — enough for the
     * tube picker to have something to draw if the row is ever surfaced, and deliberately not
     * worth authoring properly until the weapon it stands for exists. It carries a warhead and
     * still has a round nose, which is the one place the tip convention is knowingly broken: a
     * mine is not a thing that comes at you, and drawing it as a dart would say that it is.
     */
    silhouette: [
      [0.5, 0.0],
      [0.484, -0.06],
      [0.44, -0.104],
      [0.38, -0.12],
      [-0.38, -0.12],
      [-0.44, -0.104],
      [-0.484, -0.06],
      [-0.5, 0.0],
      [-0.484, 0.06],
      [-0.44, 0.104],
      [-0.38, 0.12],
      [0.38, 0.12],
      [0.44, 0.104],
      [0.484, 0.06],
    ],
    role: 'mine',
    behaviour: 'inert',
    cost: 10,
    speed: 8,
    range: 800,
    seeker: 'passive',
    damage: 130,
    description:
      'Transits to a point, holds depth, and waits about ten minutes. Several at staggered ' +
      'depths make a vertical curtain across a chokepoint.',
    /*
     * The last unbuilt load, and `deployable: false` is not "unbalanced" — it is "unbuilt". A mine
     * needs two things the run-out does not have: a proximity fuze that waits ten minutes without
     * arming on the boat that laid it, and a weapon that *stops* and holds depth, which nothing
     * in the water does today. `inert` is therefore a placeholder rather than a description — a
     * mine put in the water as it stands would sail off in a straight line. A tube may only be
     * loaded with a load `deployable` is true for, so nobody can find that out the hard way.
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
 * ╔═══════════════════════════════════════════════════════════════════════════════════╗
 * ║  THE LAUNCH KNOB — seconds a weapon holds its heading before opening the throttle. ║
 * ╚═══════════════════════════════════════════════════════════════════════════════════╝
 *
 * Time added to the launch phase **after** the weapon has come onto its bearing, not before, and
 * that is the whole of what it buys. Coming onto a heading and *settling* on one are different
 * things: the bearing to the aim point keeps moving while the weapon creeps toward it, so a
 * weapon that opens the throttle on the first tick it is nominally aligned leaves on a heading
 * that was still swinging. Held for a second or two at creep speed, steering the whole time, the
 * swing damps out and it departs on the bearing it will actually fly.
 *
 * Cheap to buy and expensive to skip, which is why the knob is worth having. A second of this
 * costs seven metres of slow water; the same second spent correcting at cruise costs a turn on a
 * circle five to twenty times wider (`match/torpedo.ts#turningRadiusOf`), and only the standard
 * torpedo can spend it — every other load flies the heading the launch phase hands it.
 *
 * **Turn it up** if weapons still leave on a bearing that is visibly off. **Turn it down** toward
 * zero if the creep out of the tube has become a tell in its own right: the phase is slow and
 * quiet, and a weapon that spends five seconds at a third of its speed is five seconds a target
 * has to be somewhere else. Zero restores "leave the moment it is aligned".
 *
 * The hold restarts if the weapon comes off its heading — a bearing that swings past it, or an
 * aim point moved out from under it — so this is time spent *settled*, not time spent since
 * first touching the mark (`match/torpedo.ts#alignedTick`).
 */
export const TORPEDO_LAUNCH_SETTLE_SECONDS = 1;

/**
 * Degrees of heading error at which a weapon stops manoeuvring and opens the throttle.
 *
 * Half a degree — **less than one tick of the slowest turn rate here**, so it means "it has
 * arrived on the heading", not "it is nearly there". Anything looser is paid for at cruising
 * speed on a circle five to twenty times wider than the one the weapon was turning on, and the
 * only load that can spend the difference is the standard torpedo, whose seeker re-aims it. A
 * drone, a decoy and a super-cavitating torpedo fly the heading the launch phase hands them.
 *
 * Measured against the plain bearing to the aim point (`sim/weapons/kinematics.ts#alignedWith`),
 * because with no pitch band there is no second heading to measure against: the weapon is asked
 * to point at the thing it was sent to, it can, and nothing takes the angle back at the throttle.
 * The one bearing it can never settle on is one to a point *inside* its own turning circle, which
 * swings as fast as the weapon orbits — that case is ended by `sim/weapons/phase.ts#settle`'s
 * arrival valve rather than by this number.
 */
export const TORPEDO_LAUNCH_ALIGNMENT = 0.5;

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
