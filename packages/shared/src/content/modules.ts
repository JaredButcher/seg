/**
 * ╔═══════════════════════════════════════════════════════════════════════════════════╗
 * ║  MODULE TABLE — tuning data. Edit the numbers here; nothing else needs touching.   ║
 * ╚═══════════════════════════════════════════════════════════════════════════════════╝
 *
 * Cost, name, icon, the slot a module fits, and its stat modifiers, all in one file.
 *
 * **No behaviour lives here — only data** (planning/05 §1). A module describes *modifiers*
 * and one resolver applies them. If a module ever seems to need bespoke code, that is a
 * signal to generalise the modifier system rather than to add a special case, because the
 * fleet editor and the server both compute final stats through the same resolver and a
 * special case would make them disagree.
 *
 * Modifier ops resolve `set` → `add` → `mul` → `min`/`max`, always in that order regardless
 * of fitting order. See applyModifiers in stats.ts.
 */

import type { SlotKind } from './hulls.js';
import type { Modifier } from './stats.js';
import type { WeaponId } from './weapons.js';

export type ModuleId =
  | 'improved-hydrophones'
  | 'sonar-filtering'
  | 'towed-array'
  | 'flow-dynamic-compensator'
  | 'silent-running-gear'
  | 'anechoic-coating'
  | 'powerful-active-sonar'
  | 'improved-reactor'
  | 'advanced-propulsor'
  | 'control-surfaces'
  | 'titanium-hull'
  | 'armor-plating'
  | 'extra-tube'
  | 'rapid-loader'
  | 'quiet-launch'
  | 'fire-control-suite'
  | 'countermeasure-reloader'
  | 'improved-active-torpedo'
  | 'improved-passive-torpedo'
  | 'improved-super-cavitating';

export interface ModuleDef {
  readonly id: ModuleId;
  readonly name: string;
  /** The one slot kind this fits. Enforced in the editor and again on the server. */
  readonly slot: SlotKind;
  readonly cost: number;
  /** Emoji glyph, standing in until the 24 px stroke icon set lands (planning/09 §11). */
  readonly icon: string;
  /** One line, shown in the picker. Say the trade, not just the benefit. */
  readonly description: string;
  readonly modifiers: readonly Modifier[];
  /**
   * The improved `WeaponId` this module grants, for the three "Improved" torpedo modules —
   * `undefined` for every other module.
   *
   * Not a `Modifier`: `Modifier` only ever changes a number on `Stats`, and what this module does
   * is make a different row of `content/weapons.ts` available in the tube it occupies
   * (`content/weapons.ts#WeaponDef.upgradeOf`, `fleet/resolve.ts#resolveBoat`). A separate field
   * rather than stretching `modifiers` to cover it, because a modifier that could name a
   * `WeaponId` instead of a `StatKey` is a modifier `applyModifiers` would have to branch on, and
   * this is the one module shape that is not a number.
   */
  readonly upgrades?: WeaponId;
}

export const MODULES: Readonly<Record<ModuleId, ModuleDef>> = {
  // ── EQUIPMENT ─────────────────────────────────────────────────────────────────
  'sonar-filtering': {
    id: 'sonar-filtering',
    name: 'Sonar Filtering Suite',
    slot: 'equipment',
    cost: 20,
    icon: '🎚️',
    description: 'Improves sonar performance',
    modifiers: [{ stat: 'arrayGain', op: 'add', value: 2 }],
  },
  'improved-hydrophones': {
    id: 'improved-hydrophones',
    name: 'Improved Hydrophones',
    slot: 'equipment',
    cost: 50,
    icon: '📡',
    description: 'Greatly improves sonar performance',
    modifiers: [{ stat: 'arrayGain', op: 'add', value: 4 }],
  },
  /*
   * The array has to be streamed out to do anything, and a boat under way faster than a crawl
   * drags it rather than trails it — so both figures below carry `condition`
   * (`content/stats.ts#Condition`) rather than applying whenever the module is merely fitted.
   * `SLOW` is deliberate rather than "under the cavitation line": the array is a fair-weather
   * instrument, not a rule about noise, and it goes slack the instant the throttle comes up even
   * on a hull that could go faster and stay quiet.
   */
  'towed-array': {
    id: 'towed-array',
    name: 'Towed Array',
    slot: 'equipment',
    cost: 40,
    icon: '〰️',
    description: 'Closes the blind arc astern and hears much further — but only at the slow notch.',
    modifiers: [
      { stat: 'arrayGain', op: 'add', value: 5, condition: { kind: 'throttle', notch: 'slow' } },
      { stat: 'baffleArc', op: 'set', value: 10, condition: { kind: 'throttle', notch: 'slow' } },
    ],
  },
  'flow-dynamic-compensator': {
    id: 'flow-dynamic-compensator',
    name: 'Flow Dynamic Compensator',
    slot: 'equipment',
    cost: 20,
    icon: '🌊',
    description: 'Counteracts some of the deafening effects of flow noise at high speeds',
    modifiers: [
      { stat: 'arrayGain', op: 'add', value: 2, condition: { kind: 'throttle', notch: 'full' } },
      { stat: 'arrayGain', op: 'add', value: 5, condition: { kind: 'throttle', notch: 'flank' } },
    ],
  },
  'silent-running-gear': {
    id: 'silent-running-gear',
    name: 'Magnetohydrodynamic Propulsion',
    slot: 'equipment',
    cost: 50,
    icon: '🔇',
    description: 'Quieter at every speed. Improves both stelth and sonar performance at speed',
    modifiers: [{ stat: 'sourceLevel', op: 'add', value: -6 }],
  },
  'anechoic-coating': {
    id: 'anechoic-coating',
    name: 'Anechoic Coating',
    slot: 'equipment',
    cost: 30,
    icon: '🛡️',
    description: 'Swallows active pings. Does nothing about the noise you make yourself.',
    modifiers: [{ stat: 'targetStrength', op: 'add', value: -5 }],
  },
  /*
   * planning/03 §3 named this module before there was an active sonar to fit it to: "a bigger
   * detection radius for a bigger self-broadcast radius". The trade needs no rule — one number
   * produces both, because a pulse is a source level like any other and the solver does not
   * care that you meant it. Eight decibels roughly doubles the range at which a return is
   * strong enough for the server to *confirm* it, and doubles the range at which the enemy
   * hears the pulse that did it.
   */
  'powerful-active-sonar': {
    id: 'powerful-active-sonar',
    name: 'Improved Transducers',
    slot: 'equipment',
    cost: 30,
    icon: '📢',
    description: 'A pulse that maps twice as far — and is heard twice as far away.',
    modifiers: [{ stat: 'pingLevel', op: 'add', value: 6 }],
  },
  'improved-reactor': {
    id: 'improved-reactor',
    name: 'Improved Reactor',
    slot: 'equipment',
    cost: 30,
    icon: '⚛️',
    description: 'Faster, and louder for it. Speed you can hear is speed the enemy can hear.',
    modifiers: [
      { stat: 'maxSpeed', op: 'add', value: 2 },
      { stat: 'sourceLevel', op: 'add', value: 2 },
    ],
  },
  'advanced-propulsor': {
    id: 'advanced-propulsor',
    name: 'Advanced Propulsor Machining',
    slot: 'equipment',
    cost: 40,
    icon: '🌀',
    description: 'Raises the speed you can make before cavitating. The only way to hurry quietly.',
    modifiers: [{ stat: 'cavitationSpeed', op: 'add', value: 2 }],
  },
  'control-surfaces': {
    id: 'control-surfaces',
    name: 'Inverted Control Surfaces',
    slot: 'equipment',
    cost: 20,
    icon: '🔻',
    description: 'Turns harder and dives steeper. Steeper pitch means faster depth changes.',
    modifiers: [
      { stat: 'turnRate', op: 'mul', value: 1.3 },
      { stat: 'maxPitch', op: 'add', value: 8 },
    ],
  },
  'titanium-hull': {
    id: 'titanium-hull',
    name: 'Titanium Hull',
    slot: 'equipment',
    cost: 40,
    icon: '💠',
    description: 'Unlocks the deep water, where it is quiet and fast and nobody else can go.',
    modifiers: [
      { stat: 'testDepth', op: 'add', value: 150 },
      { stat: 'crushDepth', op: 'add', value: 200 },
      { stat: 'maxHp', op: 'mul', value: 1.1 },
    ],
  },
  'armor-plating': {
    id: 'armor-plating',
    name: 'Armor Plating',
    slot: 'equipment',
    cost: 30,
    icon: '🧱',
    description: 'Spaced armor and compartmentalization improves survivability. At the cost of top speed and sonar reflections.',
    modifiers: [
      { stat: 'maxHp', op: 'mul', value: 1.6 },
      { stat: 'maxSpeed', op: 'add', value: -1 },
      { stat: 'targetStrength', op: 'add', value: 2 },
    ],
  },

  // ── WEAPON ────────────────────────────────────────────────────────────────────
  'extra-tube': {
    id: 'extra-tube',
    name: 'Extra Torpedo Tube',
    slot: 'weapon',
    cost: 30,
    icon: '➕',
    description: 'One more shot in the water before anything has to reload.',
    modifiers: [{ stat: 'torpedoTubes', op: 'add', value: 1 }],
  },
  'rapid-loader': {
    id: 'rapid-loader',
    name: 'Rapid Loader',
    slot: 'weapon',
    cost: 30,
    icon: '⏱️',
    description: 'More powerful hydraulic lifts and rams cut a quarter off the reload.',
    modifiers: [{ stat: 'reloadSeconds', op: 'mul', value: 0.75 }],
  },
  /*
   * `sourceLevel` was the wrong stat here — it is the boat's continuous machinery, and a launch
   * is a transient, not a continuum. `launchNoise` (`content/stats.ts`) is the one the
   * `torpedo-launch` bang actually decays from (`sim/acoustics/boats.ts#ringingSounds`), and it
   * is the only module in the table that moves it.
   */
  'quiet-launch': {
    id: 'quiet-launch',
    name: 'Quiet Launch System',
    slot: 'weapon',
    cost: 20,
    icon: '🤫',
    description: 'Fire without immediately announcing where the shot came from.',
    modifiers: [{ stat: 'launchNoise', op: 'add', value: -30 }],
  },
  'fire-control-suite': {
    id: 'fire-control-suite',
    name: 'Fire Control Suite',
    slot: 'weapon',
    cost: 30,
    icon: '🎯',
    description: 'Better firing solutions from worse contacts, and a faster reload with them.',
    modifiers: [
      { stat: 'reloadSeconds', op: 'add', value: -3 },
      { stat: 'arrayGain', op: 'add', value: 1 },
    ],
  },
  /*
   * `rapid-loader`'s own counterpart for the one slot that is not a tube: the launcher has its
   * own clock now (`content/stats.ts#countermeasureReloadSeconds`), so this is the module that
   * speeds up specifically it, leaving a boat's tubes exactly as fast as they were.
   */
  'countermeasure-reloader': {
    id: 'countermeasure-reloader',
    name: 'Countermeasure Reloader',
    slot: 'equipment',
    cost: 20,
    icon: '🔁',
    description: 'Cuts a quarter off the noisemaker launcher. Leaves the tubes alone.',
    modifiers: [{ stat: 'countermeasureReloadSeconds', op: 'mul', value: 0.75 }],
  },

  // ── IMPROVED TORPEDOES ───────────────────────────────────────────────────────
  //
  // One per torpedo (`content/weapons.ts`), each occupying a weapon slot — the same slot
  // `extra-tube`, `rapid-loader`, `quiet-launch`, and `fire-control-suite` compete for, which is
  // the whole of the trade: the upgrade is paid for in tube count or reload speed forgone, not in
  // anything about the weapon itself. `upgrades` names the improved `WeaponId` the module grants;
  // `modifiers` is empty because nothing here touches `Stats` — see `ModuleDef.upgrades`.
  'improved-active-torpedo': {
    id: 'improved-active-torpedo',
    name: 'Improved Active Torpedo',
    slot: 'weapon',
    cost: 30,
    icon: '⚡',
    description: 'A heavier warhead, longer range, and stronger ping',
    modifiers: [],
    upgrades: 'improved-active-torpedo',
  },
  'improved-passive-torpedo': {
    id: 'improved-passive-torpedo',
    name: 'Improved Passive Torpedo',
    slot: 'weapon',
    cost: 30,
    icon: '👂',
    description: 'A heavier warhead, more senstive hydrophones, and faster',
    modifiers: [],
    upgrades: 'improved-passive-torpedo',
  },
  'improved-super-cavitating': {
    id: 'improved-super-cavitating',
    name: 'Improved Super-cavitating Torpedo',
    slot: 'weapon',
    cost: 30,
    icon: '🚀',
    description: 'Harder, Better, Faster, Stronger',
    modifiers: [],
    upgrades: 'improved-super-cavitating',
  },
};

export const MODULE_IDS: readonly ModuleId[] = Object.keys(MODULES) as ModuleId[];

export function getModule(id: ModuleId): ModuleDef {
  return MODULES[id];
}

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === 'string' && (MODULE_IDS as readonly string[]).includes(value);
}

/** Everything that fits a given slot kind — exactly what the slot picker lists. */
export function modulesForSlot(kind: SlotKind): readonly ModuleDef[] {
  return MODULE_IDS.map((id) => MODULES[id]).filter((m) => m.slot === kind);
}
