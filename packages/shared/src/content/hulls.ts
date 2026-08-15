/**
 * ╔═══════════════════════════════════════════════════════════════════════════════════╗
 * ║  HULL TABLE — tuning data. Edit the numbers here; nothing else needs touching.     ║
 * ╚═══════════════════════════════════════════════════════════════════════════════════╝
 *
 * Every hull's cost, name, icon, slot counts, and base stats live in this one file, so a
 * balance pass is a diff in a data table rather than a hunt through the UI. The stat *keys*
 * and how each is displayed are in stats.ts; the fleet editor's panel is generated from
 * them, so a hull gaining a stat needs no UI work.
 *
 * **Numbers are first-pass placeholders.** They exist so systems can be built against
 * concrete values (planning/05 preamble). What should not move without discussion is the
 * *shape* of each class: what it is for and what it gives up.
 *
 * Lengths and silhouettes come from the authored art in `assets/hulls/` — the SVG outline
 * **is** the collision shape (`sim/collision`) as well as the acoustic reflector and the fleet
 * editor's icon, so length here and length there must not drift.
 *
 * ## The turn rates are set from the reversal time
 *
 * planning/04 §5 states the pacing target directly: a direction reversal should take **30–60 s**,
 * and that is the primary control on whether the game reads as an RTS or as a shooter. The three
 * `turnRate` figures are that band divided between the classes — a Light comes about in 30 s, a
 * Medium in 40, a Heavy in 60 — rather than numbers chosen for their own sake.
 *
 * That still leaves every hull unable to turn round inside a passage, which §5 also asks for: at
 * flank a boat's turning circle is `v/ω`, so 143 m for a Light and 239 m for a Heavy against a
 * 200 m minimum passage width. Entering a corridor remains a decision you live with.
 */

import type { Stats } from './stats.js';

export type HullId = 'light' | 'medium' | 'heavy';

/**
 * Slot categories. Two for now, as scoped: equipment covers sensors, machinery and hull
 * fittings; weapon covers tubes and their fire control.
 *
 * Kept as a union rather than a boolean so splitting equipment into the finer categories
 * from planning/05 §3 later is a data change plus a label, not a rewrite of slot logic.
 */
export const SLOT_KINDS = ['equipment', 'weapon'] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

export const SLOT_LABELS: Readonly<Record<SlotKind, string>> = {
  equipment: 'Equipment',
  weapon: 'Weapon',
};

export interface Hull {
  readonly id: HullId;
  readonly name: string;
  /** One line in the hull picker: what this boat is for. */
  readonly role: string;
  readonly description: string;
  /** Fleet points before any modules. */
  readonly cost: number;
  /** Metres. Matches the authored silhouette in assets/hulls/. */
  readonly length: number;
  /** Metres. Drives which passages the hull can enter (planning/04 §5.1). */
  readonly clearanceRadius: number;
  /**
   * Side-profile outline, in metres, origin at the hull's centre, +x toward the bow and +y
   * down — simulation coordinates (planning/04 §2).
   *
   * Authored in `assets/hulls/*.svg` and copied here as the single source both the editor's
   * icon and, later, the collision shape and active-sonar ray target read from. One asset,
   * four jobs (planning/09 §11) — so it must not be redrawn per consumer.
   */
  readonly silhouette: readonly (readonly [number, number])[];
  /** How many slots of each kind this hull carries. */
  readonly slots: Readonly<Record<SlotKind, number>>;
  readonly stats: Stats;
}

export const HULLS: Readonly<Record<HullId, Hull>> = {
  // ── LIGHT ─────────────────────────────────────────────────────────────────────
  light: {
    id: 'light',
    name: 'Light',
    role: 'Scout and infiltrator',
    description:
      'Small, quiet, and able to use passages nothing else fits through. Dies to a single ' +
      'torpedo, so it survives by not being found.',
    cost: 100,
    length: 73,
    clearanceRadius: 16,
    // Kilo pattern — assets/hulls/light-kilo.svg
    silhouette: [
      [36.5, 0.0],
      [33.5, -2.9],
      [26.0, -4.7],
      [14.5, -4.9],
      [12.0, -9.8],
      [2.0, -9.8],
      [0.0, -4.9],
      [-14.0, -4.9],
      [-22.0, -4.4],
      [-29.0, -3.0],
      [-34.0, -1.2],
      [-36.5, 0.0],
      [-34.0, 1.2],
      [-29.0, 3.0],
      [-22.0, 4.4],
      [-14.0, 4.9],
      [26.0, 4.7],
      [33.5, 2.9],
    ],
    slots: { equipment: 3, weapon: 1 },
    stats: {
      maxHp: 65,
      maxSpeed: 15,
      cavitationSpeed: 6.5,
      // 180° in 30 s — the quick end of planning/04 §5's reversal band, which is the class.
      turnRate: 6,
      maxPitch: 34,
      testDepth: 500,
      crushDepth: 700,
      sourceLevel: 41,
      arrayGain: 6,
      // The smallest transducer of the three. A Light that pings has thrown away the only
      // thing keeping it alive, so it is given the least reason to.
      pingLevel: 108,
      targetStrength: -4,
      baffleArc: 25,
      torpedoTubes: 2,
      reloadSeconds: 38,
      countermeasureReloadSeconds: 38,
      // Same figure on every hull — `content/acoustics.ts#TRANSIENTS`'s own `torpedo-launch`
      // level (`TRANSIENT_BASE + 25`), copied here so a module has a number to move
      // (`content/modules.ts#quiet-launch`). Nothing about the tube differs by class.
      launchNoise: 85,
    },
  },

  // ── MEDIUM ────────────────────────────────────────────────────────────────────
  medium: {
    id: 'medium',
    name: 'Medium',
    role: 'The default boat',
    description:
      'Nothing it does is bad. Enough tubes to matter, enough sensors to find something, ' +
      'and it fits most of the map.',
    cost: 150,
    length: 140,
    clearanceRadius: 32,
    // Delta pattern — assets/hulls/medium-delta.svg
    silhouette: [
      [70.0, 0.0],
      [65.7, -3.2],
      [58.2, -5.2],
      [32.3, -5.2],
      [28.5, -11.6],
      [15.1, -11.6],
      [11.8, -7.3],
      [6.5, -10.3],
      [-34.5, -10.3],
      [-44.2, -6.5],
      [-53.8, -4.5],
      [-64.6, -2.2],
      [-70.0, 0.0],
      [-64.6, 2.2],
      [-53.8, 4.5],
      [-44.2, 5.2],
      [58.2, 5.2],
      [65.7, 3.2],
    ],
    slots: { equipment: 3, weapon: 2 },
    stats: {
      maxHp: 110,
      maxSpeed: 14,
      cavitationSpeed: 5.5,
      // 180° in 40 s.
      turnRate: 4.5,
      maxPitch: 28,
      testDepth: 450,
      crushDepth: 650,
      sourceLevel: 48,
      arrayGain: 5,
      pingLevel: 116,
      targetStrength: 0,
      baffleArc: 30,
      torpedoTubes: 3,
      reloadSeconds: 32,
      countermeasureReloadSeconds: 32,
      launchNoise: 85,
    },
  },

  // ── HEAVY ─────────────────────────────────────────────────────────────────────
  heavy: {
    id: 'heavy',
    name: 'Heavy',
    role: 'Torpedo platform',
    description:
      'Carries the ordnance and takes the hits. Slow in three senses at once — low top ' +
      'speed, shallow pitch, and too wide for most passages, so it takes the long way round.',
    cost: 200,
    length: 170,
    clearanceRadius: 52,
    // Ohio pattern — assets/hulls/heavy-ohio.svg
    silhouette: [
      [85.0, 0.0],
      [81.7, -3.4],
      [74.5, -5.6],
      [62.8, -6.4],
      [44.5, -6.4],
      [39.2, -14.6],
      [26.2, -14.6],
      [23.5, -6.4],
      [-39.2, -6.4],
      [-57.5, -5.5],
      [-71.9, -3.4],
      [-80.4, -1.3],
      [-85.0, 0.0],
      [-80.4, 1.3],
      [-71.9, 3.4],
      [-57.5, 5.5],
      [-39.2, 6.4],
      [62.8, 6.4],
      [74.5, 5.6],
      [81.7, 3.4],
    ],
    slots: { equipment: 2, weapon: 3 },
    stats: {
      maxHp: 185,
      maxSpeed: 13,
      cavitationSpeed: 4.5,
      // 180° in 60 s — the slow end of the band, and still 239 m of turning circle at flank.
      turnRate: 3,
      maxPitch: 22,
      testDepth: 400,
      crushDepth: 600,
      sourceLevel: 58,
      arrayGain: 4,
      pingLevel: 124,
      targetStrength: 6,
      baffleArc: 40,
      torpedoTubes: 4,
      reloadSeconds: 30,
      countermeasureReloadSeconds: 30,
      launchNoise: 85,
    },
  },
};

export const HULL_IDS: readonly HullId[] = ['light', 'medium', 'heavy'];

export function getHull(id: HullId): Hull {
  return HULLS[id];
}

export function isHullId(value: unknown): value is HullId {
  return typeof value === 'string' && (HULL_IDS as readonly string[]).includes(value);
}

/** Total slots on a hull, across every kind. */
export function totalSlots(hull: Hull): number {
  return SLOT_KINDS.reduce((sum, kind) => sum + hull.slots[kind], 0);
}
