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

export type ModuleId =
  | 'improved-hydrophones'
  | 'sonar-filtering'
  | 'towed-array'
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
  | 'fire-control-suite';

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
}

export const MODULES: Readonly<Record<ModuleId, ModuleDef>> = {
  // ── EQUIPMENT ─────────────────────────────────────────────────────────────────
  'improved-hydrophones': {
    id: 'improved-hydrophones',
    name: 'Improved Hydrophones',
    slot: 'equipment',
    cost: 25,
    icon: '📡',
    description: 'Hears further. No downside except the points and the slot.',
    modifiers: [{ stat: 'arrayGain', op: 'add', value: 4 }],
  },
  'sonar-filtering': {
    id: 'sonar-filtering',
    name: 'Sonar Filtering Suite',
    slot: 'equipment',
    cost: 30,
    icon: '🎚️',
    description: 'Cleaner picture: better classification and steadier bearings.',
    modifiers: [{ stat: 'arrayGain', op: 'add', value: 2 }],
  },
  'towed-array': {
    id: 'towed-array',
    name: 'Towed Array',
    slot: 'equipment',
    cost: 40,
    icon: '〰️',
    description: 'Closes the blind arc astern and hears much further — but only at creep.',
    modifiers: [
      { stat: 'arrayGain', op: 'add', value: 5 },
      { stat: 'baffleArc', op: 'set', value: 10 },
    ],
  },
  'silent-running-gear': {
    id: 'silent-running-gear',
    name: 'Silent Running Gear',
    slot: 'equipment',
    cost: 35,
    icon: '🔇',
    description: 'Quieter at every speed. The most direct way to not be found.',
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
    name: 'Powerful Active Sonar',
    slot: 'equipment',
    cost: 35,
    icon: '📢',
    description: 'A pulse that maps twice as far — and is heard twice as far away.',
    modifiers: [{ stat: 'pingLevel', op: 'add', value: 8 }],
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
    name: 'Advanced Propulsor',
    slot: 'equipment',
    cost: 40,
    icon: '🌀',
    description: 'Raises the speed you can make before cavitating. The only way to hurry quietly.',
    modifiers: [{ stat: 'cavitationSpeed', op: 'add', value: 2 }],
  },
  'control-surfaces': {
    id: 'control-surfaces',
    name: 'Control Surfaces',
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
    cost: 45,
    icon: '💠',
    description: 'Unlocks the deep water, where it is quiet and fast and nobody else can go.',
    modifiers: [
      { stat: 'testDepth', op: 'add', value: 150 },
      { stat: 'crushDepth', op: 'add', value: 180 },
      { stat: 'maxHp', op: 'mul', value: 1.1 },
    ],
  },
  'armor-plating': {
    id: 'armor-plating',
    name: 'Armor Plating',
    slot: 'equipment',
    cost: 30,
    icon: '🧱',
    description: 'Survives a hit it should not have taken. Slower, and easier to ping.',
    modifiers: [
      { stat: 'maxHp', op: 'mul', value: 1.4 },
      { stat: 'maxSpeed', op: 'add', value: -1 },
      { stat: 'targetStrength', op: 'add', value: 2 },
    ],
  },

  // ── WEAPON ────────────────────────────────────────────────────────────────────
  'extra-tube': {
    id: 'extra-tube',
    name: 'Extra Torpedo Tube',
    slot: 'weapon',
    cost: 35,
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
    description: 'Cuts a quarter off the reload. Turns a missed salvo into a survivable one.',
    modifiers: [{ stat: 'reloadSeconds', op: 'mul', value: 0.75 }],
  },
  'quiet-launch': {
    id: 'quiet-launch',
    name: 'Quiet Launch System',
    slot: 'weapon',
    cost: 25,
    icon: '🤫',
    description: 'Fire without immediately announcing where the shot came from.',
    modifiers: [{ stat: 'sourceLevel', op: 'add', value: -2 }],
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
