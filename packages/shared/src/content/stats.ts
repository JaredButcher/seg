/**
 * The stat vocabulary — what a hull has, what a module can change, and how each one is
 * written for a player.
 *
 * This file is the *schema*; hulls.ts and modules.ts are the *data*. Adding a stat means
 * adding it here first, and then the fleet editor picks it up without further work: the
 * stat panel is generated from `STAT_ORDER`, not hand-written.
 */

export const STAT_KEYS = [
  'maxHp',
  'maxSpeed',
  'cavitationSpeed',
  'turnRate',
  'maxPitch',
  'testDepth',
  'crushDepth',
  'sourceLevel',
  'arrayGain',
  'pingLevel',
  'targetStrength',
  'baffleArc',
  'torpedoTubes',
  'reloadSeconds',
  'countermeasureReloadSeconds',
] as const;

export type StatKey = (typeof STAT_KEYS)[number];

/** A full stat block. Every hull declares all of these; modules adjust them. */
export type Stats = Record<StatKey, number>;

/**
 * Which direction is good, so the editor can colour a change without a per-stat rule.
 *
 * `lower` is not a rarity: a quieter boat has a *lower* source level, and getting that
 * backwards would tell a player a silencing module made them louder.
 */
export type StatDirection = 'higher' | 'lower';

export interface StatMeta {
  readonly key: StatKey;
  readonly label: string;
  readonly unit: string;
  readonly better: StatDirection;
  /** Decimal places when displayed. Integers where a fraction would be noise. */
  readonly precision: number;
  /** Short line shown in the editor. Kept here so the data files stay pure numbers. */
  readonly blurb: string;
}

export const STATS: Readonly<Record<StatKey, StatMeta>> = {
  maxHp: {
    key: 'maxHp',
    label: 'Hull integrity',
    unit: 'hp',
    better: 'higher',
    precision: 0,
    blurb: 'Damage absorbed before the boat is lost. There is no repair.',
  },
  maxSpeed: {
    key: 'maxSpeed',
    label: 'Max speed',
    unit: 'm/s',
    better: 'higher',
    precision: 1,
    blurb: 'Flat out. Almost always louder than it is worth.',
  },
  cavitationSpeed: {
    key: 'cavitationSpeed',
    label: 'Cavitation speed',
    unit: 'm/s',
    better: 'higher',
    precision: 1,
    blurb: 'The speed at which the screw starts screaming. At 200 m; deeper water raises it.',
  },
  turnRate: {
    key: 'turnRate',
    label: 'Turn rate',
    unit: '°/s',
    better: 'higher',
    precision: 1,
    blurb: 'How fast the bow comes round. Reversing left/right is a flip at a stop, not a turn.',
  },
  maxPitch: {
    key: 'maxPitch',
    label: 'Max pitch',
    unit: '°',
    better: 'higher',
    precision: 0,
    blurb: 'Descent rate is speed × sin(pitch), so this is how fast you can change depth.',
  },
  testDepth: {
    key: 'testDepth',
    label: 'Test depth',
    unit: 'm',
    better: 'higher',
    precision: 0,
    blurb: 'Below this the hull groans, which is a noise the enemy can hear.',
  },
  crushDepth: {
    key: 'crushDepth',
    label: 'Crush depth',
    unit: 'm',
    better: 'higher',
    precision: 0,
    blurb: 'Past this the boat is gone. It is a line drawn on the scope.',
  },
  sourceLevel: {
    key: 'sourceLevel',
    label: 'Source level',
    unit: 'dB',
    better: 'lower',
    precision: 0,
    blurb: 'How loud the boat is at rest. The single most consequential stat here.',
  },
  arrayGain: {
    key: 'arrayGain',
    label: 'Array gain',
    unit: 'dB',
    better: 'higher',
    precision: 0,
    blurb: 'How well it hears. Trades directly against how far away you can sit.',
  },
  /*
   * Marked `higher` because that is what the stat *does* — a stronger pulse lights more of the
   * ocean. It is the one stat in the table whose improvement is unambiguously also a cost, and
   * the cost is not expressible as a number: the pulse that images a cave wall a kilometre away
   * is heard by every boat on the map (planning/03 §3). The editor colours the change green and
   * the module's own description carries the trade, which is the honest division of labour —
   * a `lower`-is-better ping would tell a player the module made their sonar worse.
   */
  pingLevel: {
    key: 'pingLevel',
    label: 'Ping strength',
    unit: 'dB',
    better: 'higher',
    precision: 0,
    blurb: 'How loud its active pulse is. Lights up the rock, and announces you to everyone.',
  },
  targetStrength: {
    key: 'targetStrength',
    label: 'Target strength',
    unit: 'dB',
    better: 'lower',
    precision: 0,
    blurb: 'How much of an active ping comes back. Lower is harder to find.',
  },
  baffleArc: {
    key: 'baffleArc',
    label: 'Baffle arc',
    unit: '°',
    better: 'lower',
    precision: 0,
    blurb: 'The blind wedge astern. Wider means more of the ocean you cannot hear.',
  },
  torpedoTubes: {
    key: 'torpedoTubes',
    label: 'Torpedo tubes',
    unit: '',
    better: 'higher',
    precision: 0,
    blurb: 'Shots in the water at once, before anything has to reload.',
  },
  reloadSeconds: {
    key: 'reloadSeconds',
    label: 'Reload',
    unit: 's',
    better: 'lower',
    precision: 0,
    blurb: 'Per tube. Long enough that a missed salvo is a real loss.',
  },
  countermeasureReloadSeconds: {
    key: 'countermeasureReloadSeconds',
    label: 'Countermeasure reload',
    unit: 's',
    better: 'lower',
    precision: 0,
    blurb: 'The noisemaker launcher. Its own clock, not a tube — a loader module leaves the other alone.',
  },
};

/** Display order in the editor's stat panel. */
export const STAT_ORDER: readonly StatKey[] = STAT_KEYS;

export function formatStat(key: StatKey, value: number): string {
  const meta = STATS[key];
  const number = value.toFixed(meta.precision);
  return meta.unit.length > 0 ? `${number} ${meta.unit}` : number;
}

/** True when `next` is an improvement on `base` for this stat. */
export function isImprovement(key: StatKey, base: number, next: number): boolean {
  return STATS[key].better === 'higher' ? next > base : next < base;
}

// ── Modifiers ───────────────────────────────────────────────────────────────────────

/**
 * How a module changes a stat. planning/05 §1.
 *
 * Resolution order is fixed and documented — `set` → `add` → `mul` → `min`/`max` clamp —
 * because players reverse-engineer stacking rules and the editor has to show the same final
 * number the server will compute.
 */
export type ModifierOp = 'set' | 'add' | 'mul' | 'min' | 'max';

export interface Modifier {
  readonly stat: StatKey;
  readonly op: ModifierOp;
  readonly value: number;
}

const OP_ORDER: readonly ModifierOp[] = ['set', 'add', 'mul', 'min', 'max'];

/**
 * Applies modifiers to a base stat block.
 *
 * Deterministic regardless of the order modules were fitted: the ops are grouped and applied
 * in the documented sequence, so two boats with the same modules always resolve identically.
 * Fitting order changing a stat would be a bug players would find in an afternoon.
 */
export function applyModifiers(base: Stats, modifiers: readonly Modifier[]): Stats {
  const out: Stats = { ...base };

  for (const op of OP_ORDER) {
    for (const modifier of modifiers) {
      if (modifier.op !== op) continue;
      const current = out[modifier.stat];
      switch (op) {
        case 'set':
          out[modifier.stat] = modifier.value;
          break;
        case 'add':
          out[modifier.stat] = current + modifier.value;
          break;
        case 'mul':
          out[modifier.stat] = current * modifier.value;
          break;
        case 'min':
          out[modifier.stat] = Math.max(current, modifier.value);
          break;
        case 'max':
          out[modifier.stat] = Math.min(current, modifier.value);
          break;
      }
    }
  }

  return out;
}
