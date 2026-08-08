/**
 * ╔═══════════════════════════════════════════════════════════════════════════════════╗
 * ║  WEAPON TABLE — tuning data. Edit the numbers here; nothing else needs touching.   ║
 * ╚═══════════════════════════════════════════════════════════════════════════════════╝
 *
 * The six tube variants from planning/05 §4, transcribed. Like hulls and modules, this file
 * is data with no behaviour: the run-out, seeker, and fuze logic that reads these numbers
 * arrives with the weapons milestone.
 *
 * **Torpedoes are unlimited** (05 §4). The constraints are tube count, reload time, and the
 * noise of firing — which is why there is no ammunition count anywhere in the data model. A
 * tube is loaded, reloading, or destroyed with its boat; it never runs out.
 *
 * **A variant is chosen per tube at fleet-build time** (Q6), so the cost below is per tube and
 * adds to fleet cost. The fleet editor does not offer that choice yet, so every tube is loaded
 * with `standard` at match start — see `DEFAULT_WEAPON`.
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
}

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
    seeker: 'switchable',
    damage: 100,
    description:
      'Quiet enough to sneak, slow enough to evade, agile enough in depth to chase a diving ' +
      'target. The baseline everything else is measured against.',
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
    seeker: 'active',
    damage: 90,
    description:
      'Nearly unavoidable inside 800 m and useless as a long shot. Cannot follow a target ' +
      'that dives hard, and announces its firing point map-wide.',
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
  },
};

export const WEAPON_IDS: readonly WeaponId[] = Object.keys(WEAPONS) as WeaponId[];

/**
 * What every tube carries until the fleet editor lets a player choose per tube (Q6).
 *
 * It costs nothing, which is what makes it a safe default: a fleet's point total does not
 * change the day the choice appears.
 */
export const DEFAULT_WEAPON: WeaponId = 'standard';

export function getWeapon(id: WeaponId): WeaponDef {
  return WEAPONS[id];
}

export function isWeaponId(value: unknown): value is WeaponId {
  return typeof value === 'string' && (WEAPON_IDS as readonly string[]).includes(value);
}
