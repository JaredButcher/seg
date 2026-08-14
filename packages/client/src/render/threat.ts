/**
 * @seg/client/render/threat — which weapon in the water is a problem, and whose problem it is.
 *
 * One answer, three surfaces. The line drawn on the scope, the alert on the fleet row, and
 * (eventually) whatever else wants to say "this one matters" all read this module, so they cannot
 * disagree about who is in trouble — a row flashing for a boat the scope has drawn no line to
 * would be worse than neither.
 *
 * ## It is a derivation, not a reading, and that is a real distinction
 *
 * Everything else the client draws is a measurement the server made: a charted square, a confirmed
 * contact, a heard launch. This is arithmetic *on top of* those measurements, which is a thing the
 * client is normally not allowed to do. It is allowed here because it invents no information —
 * every input is either a pose the team has already confirmed or a row of the shipped content
 * table, and the output is a conclusion any player with a ruler and ten seconds would reach from
 * the same screen. What it saves is the ten seconds, which in this game is the whole engagement.
 *
 * The corollary is that it must degrade with the picture rather than around it. A contact that has
 * not been identified yields a poorer threat test, not a guessed one; a contact that has slipped
 * yields none at all, because its pose is no longer something the sonar stands behind.
 *
 * ## Closest point of approach
 *
 * The geometry is the one a fire-control party has always used. With the weapon at `p` running
 * along `d` at `v`, and the target at `b` making `u`:
 *
 * ```
 * r = p − b            where it is, relative to me
 * w = v·d − u          how that gap is moving
 *
 * closing  ⟺  r · w < 0
 * t_cpa    =  −(r · w) / |w|²          seconds until it is as close as it will get
 * cpa      =  | r + w·t_cpa |          how close that is
 * ```
 *
 * The sign of one dot product answers "is it coming at me" with no history, no smoothing, and no
 * differencing of noisy ten-hertz poses — which matters, because the alternative (tracking range
 * over time) breaks every time a contact drops and is re-confirmed a second later somewhere
 * slightly different.
 *
 * **`t_cpa` is on its present course**, and against a homing weapon that is a lower bound on the
 * trouble rather than a prediction: a seeker that acquires will turn, and the comfortable 200 m
 * miss this reports will stop being comfortable. That is why the seeker radius below is a separate,
 * much wider test rather than a tightening of this one — the straight line is what the weapon is
 * doing, and the arc is what it is *able* to do.
 *
 * ## What makes something worth flagging
 *
 * Three gates, and a weapon has to pass all three. The point of having three is that a torpedo
 * crossing the map is not a threat to everybody it happens to be pointed near, and an alert that
 * fires for every weapon in the water is an alert players learn to ignore.
 *
 * 1. **Closing.** `r · w < 0`. A weapon that has already passed you is somebody else's problem.
 * 2. **Soon.** `t_cpa` inside `THREAT_HORIZON_SECONDS`. A weapon ninety seconds out will have been
 *    re-measured a dozen times before it matters, and flagging it now spends the alert's credibility
 *    on a prediction.
 * 3. **Close enough**, against a radius that depends on what the weapon can actually do:
 *    - **Anything** is a threat if its CPA is inside its own burst — `damageRadius` plus half the
 *      hull it is passing. That is the whole test for a super-cavitating weapon, which cannot be
 *      talked off its line and will hit exactly what it was pointed at or nothing.
 *    - **A homing weapon** is a threat much further out, but only *ahead of itself*: a seeker looks
 *      through `SEEKER_ARC` off its nose and is deaf outside it (`sim/weapons/seeker.ts`). Inside
 *      that cone the radius is the range it would actually acquire from, which is a different
 *      number for the two loads and — for the passive one — a different number depending on how
 *      loud the target is being.
 *
 * That last point is the one worth having built this for. A passive torpedo's threat radius
 * shrinks as you slow down, so the alert on your own fleet row *goes away* when you go quiet. The
 * counter to the weapon and the disappearance of the warning about it are the same act.
 */

import {
  ACOUSTICS,
  DEPLOYABLE_WEAPON_IDS,
  SEEKER_ARC,
  getHull,
  getWeapon,
  hullMaterial,
  imagingReach,
  rangeForLoss,
  seekerThreshold,
  sourceLevelOf,
  type EntityId,
  type HullId,
  type Stats,
  type Vec2,
  type WeaponId,
} from '@seg/shared';

/**
 * How far ahead the solver is willing to predict, seconds.
 *
 * A weapon further out than this is not yet a fact about anybody. The pose will be re-measured ten
 * times a second for the whole of the intervening minute, and an alert raised now would be spending
 * its credibility on arithmetic rather than on a reading — the player would learn that the icon
 * comes on long before anything happens, which is the same as learning to ignore it.
 */
export const THREAT_HORIZON_SECONDS = 45;

/**
 * The radius assumed for a hostile weapon the team has heard but not identified, metres.
 *
 * The one number here that is not derived from something, and it is deliberately generous. Below
 * `identificationThreshold` a team knows a weapon is in the water and nothing else — it could be a
 * super-cavitating round that will miss by 50 m and not care, or a homing one that will hear you
 * from three hundred. Assuming the harmless case would suppress the warning in exactly the
 * situation the player has least information to work with, so this assumes it can home, at roughly
 * what an active seeker manages against a bare hull.
 *
 * The moment the contact clears `identificationThreshold` this is replaced by the load's real
 * reach, which is usually smaller — so identifying a weapon can *remove* an alert, which is
 * correct and worth seeing happen.
 */
export const THREAT_UNKNOWN_RADIUS_M = 350;

/**
 * And the speed assumed for one, m/s — the cruise speed of both homing torpedoes.
 *
 * A contact never carries a rate, so without a load there is no speed, and without a speed there is
 * no `t_cpa` and nothing to gate on the horizon. Something has to be assumed, and this assumes the
 * *slow* answer, which looks like the wrong way round for a warning until you ask which load a team
 * is likely to be unable to identify.
 *
 * It is never the fast one. A super-cavitating weapon radiates 92 dB against a homing torpedo's 62
 * — thirty decibels, which is the loudest continuous thing in the game against one of the quietest
 * — so it clears `identificationThreshold` at a range where the homing loads are still a generic
 * dart. In practice the unidentified contact is a homing torpedo, and assuming it sprints would
 * put an alarmist number of seconds on the one reading the player cannot check.
 */
export const THREAT_UNKNOWN_SPEED_MS = 22;

/**
 * The widest burst any deployable load carries, metres — what an unidentified one is assumed to
 * have when it is not pointed at anybody in particular.
 *
 * Read off the table rather than written down, so a load added with a bigger warhead widens the
 * assumption without anyone remembering to come here.
 */
const WORST_BURST_M = Math.max(...DEPLOYABLE_WEAPON_IDS.map((id) => getWeapon(id).damageRadius));

/** One weapon in the water, as the solver reads it. Yours or his. */
export interface ThreatWeapon {
  /** The caller's own identity for it — an entity id for yours, a contact id for his. */
  readonly key: string;
  readonly pos: Vec2;
  /** Degrees. The way it is going, which for anything but a turning seeker is the way it will go. */
  readonly facing: number;
  /** The load, or `null` for a hostile contact below `identificationThreshold`. */
  readonly weapon: WeaponId | null;
  /**
   * m/s if it is known, else `null`.
   *
   * Your own weapons carry a measured speed; a contact never does, because the picture measures a
   * pose and never a rate. The fallbacks run in order: the identified load's cruise speed, and
   * failing that `THREAT_UNKNOWN_SPEED_MS`.
   */
  readonly speed: number | null;
}

/** One thing a weapon might hit, and everything needed to say how easily. */
export interface ThreatTarget {
  readonly id: EntityId;
  readonly pos: Vec2;
  readonly facing: number;
  readonly speed: number;
  readonly hull: HullId;
  /**
   * Its resolved stat block — its coating, for an active seeker's echo, and its machinery, for a
   * passive one's ear.
   *
   * For your own boats this is the real thing off `MatchSetup`. For a confirmed hostile it is the
   * *class's* nominal block, which is all the team has actually established: confirmation reveals
   * the hull, not the fit-out.
   */
  readonly stats: Stats;
  /** Game depth, metres. Only a passive seeker's radius reads it, through cavitation. */
  readonly depth: number;
}

/** One weapon, one target, and how bad it is. */
export interface Threat {
  /** The weapon's `key`, handed back so the caller can find its pose again. */
  readonly weapon: string;
  readonly target: EntityId;
  /** The two ends of the line to draw. Poses as last measured — never extrapolated. */
  readonly from: Vec2;
  readonly to: Vec2;
  /** Seconds until it is as close as it is going to get. Drives how urgent the alert looks. */
  readonly seconds: number;
  /** How close that is, metres. */
  readonly cpa: number;
}

/**
 * The one target this weapon is most likely to reach, or `null` if it threatens nobody.
 *
 * **Most likely, not nearest.** A weapon can pass close aboard one boat on its way to another, and
 * the one it is going to hit is the one whose closest approach is smallest — which is not the same
 * question as which is nearest right now, and is the whole reason this is CPA arithmetic rather
 * than a distance sort. Ties go to the sooner of the two, because that is the one the player has
 * less time to do anything about.
 */
export function threatOf(weapon: ThreatWeapon, targets: readonly ThreatTarget[]): Threat | null {
  const def = weapon.weapon === null ? null : getWeapon(weapon.weapon);
  const speed = weapon.speed ?? def?.speed ?? THREAT_UNKNOWN_SPEED_MS;
  if (speed <= 0) return null;

  const radians = (weapon.facing * Math.PI) / 180;
  const heading = { x: Math.cos(radians), y: Math.sin(radians) };

  let best: Threat | null = null;

  for (const target of targets) {
    const solved = approachOf(weapon.pos, heading, speed, target);
    if (solved === null) continue;
    if (solved.seconds > THREAT_HORIZON_SECONDS) continue;
    if (solved.cpa > reachAgainst(weapon, def, heading, target)) continue;

    if (
      best === null ||
      solved.cpa < best.cpa ||
      (solved.cpa === best.cpa && solved.seconds < best.seconds)
    ) {
      best = {
        weapon: weapon.key,
        target: target.id,
        from: weapon.pos,
        to: target.pos,
        seconds: solved.seconds,
        cpa: solved.cpa,
      };
    }
  }

  return best;
}

/** Every weapon that threatens something, at most one target each. */
export function threatsAmong(
  weapons: readonly ThreatWeapon[],
  targets: readonly ThreatTarget[],
): readonly Threat[] {
  if (weapons.length === 0 || targets.length === 0) return [];

  const out: Threat[] = [];
  for (const weapon of weapons) {
    const threat = threatOf(weapon, targets);
    if (threat !== null) out.push(threat);
  }
  return out;
}

/**
 * Both directions of the threat picture, for one frame.
 *
 * Two lists rather than one because they are drawn differently and mean different things: the
 * incoming line is an **alarm** — something is about to happen to you and you have seconds — and
 * the outgoing one is a **receipt**, saying only that the shot you already took is still on track.
 * Drawing them alike would put the same weight on a decision the player has yet to make and one
 * they made forty seconds ago.
 *
 * The shape lives here rather than beside the function that fills it (`ui/hud/rows.ts#fleetThreats`)
 * so that the scope can name it without reaching up into the HUD for a type.
 */
export interface FleetThreats {
  /** His weapons closing on your team's boats. Drawn boldly; a fleet row flashes for one. */
  readonly incoming: readonly Threat[];
  /** Your weapons closing on his confirmed contacts. The faint line. */
  readonly outgoing: readonly Threat[];
  /** Which friendly boats are being threatened. All the fleet list needs. */
  readonly threatened: ReadonlySet<EntityId>;
}

/** The empty answer, shared so a quiet frame allocates nothing at all. */
export const NO_THREATS: FleetThreats = { incoming: [], outgoing: [], threatened: new Set() };

/** The ids being threatened, for a surface that only needs to know *whether* — the fleet list. */
export function threatenedIds(threats: readonly Threat[]): ReadonlySet<EntityId> {
  const out = new Set<EntityId>();
  for (const threat of threats) out.add(threat.target);
  return out;
}

// ── internals ───────────────────────────────────────────────────────────────────────

/** Closest approach on present courses, or `null` if the gap is opening. */
function approachOf(
  pos: Vec2,
  heading: Vec2,
  speed: number,
  target: ThreatTarget,
): { readonly seconds: number; readonly cpa: number } | null {
  const rx = pos.x - target.pos.x;
  const ry = pos.y - target.pos.y;

  const course = (target.facing * Math.PI) / 180;
  const wx = speed * heading.x - target.speed * Math.cos(course);
  const wy = speed * heading.y - target.speed * Math.sin(course);

  // The whole of "is it closing", and it is one dot product. Zero counts as opening: a weapon on a
  // perfectly parallel course is not getting any closer than it already is, and `t_cpa` below
  // would be zero anyway.
  const closing = rx * wx + ry * wy;
  if (closing >= 0) return null;

  const rate = wx * wx + wy * wy;
  // Matched speeds on a matched course. It is closing by the test above and yet never arrives,
  // which is a geometry the horizon should reject rather than divide by.
  if (rate <= 0) return null;

  const seconds = -closing / rate;
  const cx = rx + wx * seconds;
  const cy = ry + wy * seconds;
  return { seconds, cpa: Math.hypot(cx, cy) };
}

/**
 * How close this weapon has to get to this target to be worth flagging, metres.
 *
 * The larger of what it can *hit* and what it can *hear*, because they are different claims: the
 * first is true of every load and the second only of a seeker, and only ahead of itself.
 */
function reachAgainst(
  weapon: ThreatWeapon,
  def: ReturnType<typeof getWeapon> | null,
  heading: Vec2,
  target: ThreatTarget,
): number {
  // Half the hull, so the test is against the boat rather than against the point at its centre —
  // a 170 m Heavy is a much easier thing to hit than its origin suggests.
  const beam = getHull(target.hull).length / 2;
  const ahead = aheadOf(weapon.pos, heading, target.pos);

  // Unidentified: assume the worst load it could be, on both counts. Ahead of the nose that means
  // assuming it homes; anywhere else it means assuming the biggest warhead in the table, since a
  // weapon that cannot see you can still run into you.
  if (def === null) return beam + (ahead ? THREAT_UNKNOWN_RADIUS_M : WORST_BURST_M);

  const physical = beam + def.damageRadius;
  if (def.behaviour !== 'seeker' || !ahead) return physical;

  return Math.max(physical, beam + acquisitionRange(def, target));
}

/** Whether the target is inside `SEEKER_ARC` of the weapon's nose — where a seeker can hear. */
function aheadOf(pos: Vec2, heading: Vec2, at: Vec2): boolean {
  const dx = at.x - pos.x;
  const dy = at.y - pos.y;
  const range = Math.hypot(dx, dy);
  if (range <= 0) return true;

  // `cos` of the angle between the nose and the bearing, without the arc-cosine.
  const alignment = (heading.x * dx + heading.y * dy) / range;
  return alignment >= Math.cos((SEEKER_ARC * Math.PI) / 180);
}

/**
 * The range this seeker would actually acquire this target from, metres.
 *
 * Both branches call the same functions the simulation does (`sim/weapons/seeker.ts`), off the same
 * shipped table, so a tuning pass moves the alert and the weapon together. That is the property
 * that makes a derived warning trustworthy rather than a second opinion.
 */
function acquisitionRange(def: ReturnType<typeof getWeapon>, target: ThreatTarget): number {
  const gate = seekerThreshold();

  // Active: its own pulse, out to the hull and back, swallowed once by the coating. A constant per
  // hull class — nothing the target does changes it, which is exactly what the ping buys.
  if (def.seeker === 'active') {
    return imagingReach(def.seekerPingLevel, gate, hullMaterial(target.stats).absorption);
  }

  // Passive: the target's own radiated noise, one way. This is the number that moves when he slows
  // down, and the reason the alert can be made to go away by going quiet.
  if (def.seeker === 'passive') {
    const level = sourceLevelOf({
      stats: target.stats,
      speed: target.speed,
      depth: target.depth,
    });
    return level > gate ? Math.min(ACOUSTICS.maxRange, rangeForLoss(level - gate)) : 0;
  }

  return 0;
}
