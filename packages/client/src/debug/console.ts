/**
 * @seg/client/debug/console — the browser-console debug commands.
 *
 * Imported once for its side effect (`main.tsx`), like `debug/inputLog.ts`: it hangs a
 * `window.seg` object off the page and does nothing else. Unlike that module this is not gated
 * on a `window.SEG_DEBUG_*` flag a developer flips for themselves — it is gated on the current
 * match's own `LobbySettings.debugMode`, a setting the *host* turns on for everyone in the
 * lobby before the match starts (`ui/LobbyScreen.tsx`), because this is a testing affordance for
 * whoever is in that match rather than a developer's personal console flag.
 *
 * Six commands:
 *
 * - `seg.vision(true | false)` — spectator-style live vision: both fleets, true position, fog
 *   of war off, while the player still only *commands* their own team. Sent immediately.
 * - `seg.field('noise' | 'detect' | 'imaging' | 'range' | null)` — an acoustic overlay under the
 *   whole scope (`@seg/shared/match/field.ts`). These are the views that show the *model* rather
 *   than its output: they answer "why did nothing detect that" directly, where the sonar picture
 *   can only show that nothing did. `seg.field()` with no argument lists them.
 *
 *   Three of the four are questions about one boat's hydrophone, and they follow the scope's
 *   selection — pick a different boat and the overlay re-measures for that one, because the boat
 *   a developer is asking about is invariably the boat they have just clicked on. With nothing
 *   selected there is nothing to ask, and the overlay waits.
 * - `seg.reach(true | false)` — two circles round every sub and torpedo carrying an active
 *   transducer: how far its own pulse would show it something, and how far away the other side
 *   would hear that pulse (`@seg/shared/match/reach.ts`). The counterpart of the fields above
 *   rather than another one of them — a field is what the water *is*, and this is what one more
 *   pulse would do to it, which is the question an active-sonar balance pass is actually made of.
 *
 *   The inner circle is read against whatever that platform hears with: rock for a boat or a
 *   drone, a hull for a torpedo, whose seeker is a receiver of its own and is what its homing is
 *   made of.
 *
 *   Drawn for every transducer in the match at once, both fleets, so there is nothing to select
 *   and nothing to follow the scope's pick with.
 * - `seg.probe(true | false)` — a panel at the bottom left, filled by ctrl+clicking the water:
 *   every number the model holds about that point, against the selected boat
 *   (`@seg/shared/match/probe.ts`). Where the overlays draw a shape and leave the reading to the
 *   eye, this is the reading — the last mile of a balance question is always one point and one
 *   listener.
 * - `seg.spawn('sub' | 'torpedo', subtype, team)` — arms the *next* click on the viewport to
 *   place the thing there, rather than taking a point as an argument: a player reading a
 *   coordinate off the scope to type into the console is a worse interface than pointing at the
 *   water, and every other command on this scope already works by clicking it.
 *
 * Every argument is validated against the content tables before anything is armed or sent, and
 * a bad one gets a console error naming the values that would have worked — the same reason
 * `describeTubeProblem` and friends exist: a developer using this from a cold console has no
 * other source of truth for what a hull or a weapon is called.
 */

import {
  DEPLOYABLE_WEAPON_IDS,
  HULL_IDS,
  isDeployableWeapon,
  isHullId,
  isDebugFieldKind,
  isTeamId,
  isWeaponId,
  FIELD_KINDS,
  FIELD_MAP_HZ,
  FIELD_SPECS,
  type DebugFieldKind,
  type DebugSpawnKind,
  type EntityId,
  type TeamId,
} from '@seg/shared';

import { useLobby } from '../state/lobby.js';
import { activeSetup, useMatch } from '../state/match.js';
import { useDebug } from './state.js';

export {};

declare global {
  interface Window {
    seg?: {
      vision(enabled: boolean): void;
      field(kind?: DebugFieldKind | null): void;
      /** The original name for `seg.field('noise')`, kept for the fingers that learned it. */
      noise(enabled: boolean): void;
      reach(enabled: boolean): void;
      probe(enabled: boolean): void;
      spawn(kind: DebugSpawnKind, subtype: string, team: TeamId): void;
    };
  }
}

const TEAM_IDS: readonly TeamId[] = ['team1', 'team2'];

/** The active match's debug flag, read fresh on every call — see the file header. */
function debugMatchAvailable(): boolean {
  const setup = activeSetup(useMatch.getState());
  if (setup === undefined) {
    console.error('[seg] No match in progress.');
    return false;
  }
  if (!setup.debugMode) {
    console.error(
      '[seg] Debug mode is off for this match. The host has to turn it on in the lobby before starting.',
    );
    return false;
  }
  return true;
}

function vision(enabled: boolean): void {
  if (typeof enabled !== 'boolean') {
    console.error('[seg] seg.vision(enabled): enabled must be true or false.');
    return;
  }
  if (!debugMatchAvailable()) return;

  useLobby.getState().setDebugVision(enabled);
  console.log(`[seg] Fog of war ${enabled ? 'disabled' : 're-enabled'}.`);
}

/**
 * Which field is being drawn, and the subscription keeping it pointed at the selected boat.
 *
 * Module-level rather than in a store because nothing renders off it: it is the console's own
 * memory of what it last asked for, and the one thing that has to survive between a `seg.field`
 * call and the next time the player clicks a different hull.
 */
let drawing: DebugFieldKind | null = null;
let unfollow: (() => void) | null = null;

/** Whether a field is a question about somebody's hydrophone, or about the water at large. */
function needsBoat(kind: DebugFieldKind): boolean {
  return kind !== 'noise';
}

/** Ask the server for `kind` measured against whichever boat is picked right now. */
function request(kind: DebugFieldKind): void {
  const boat: EntityId | null = needsBoat(kind) ? useMatch.getState().selected : null;
  useLobby.getState().setDebugField(kind, boat);
  if (needsBoat(kind) && boat === null) {
    console.warn(`[seg] seg.field('${kind}') needs a boat — click one, or press its number key.`);
  }
}

function field(kind?: DebugFieldKind | null): void {
  if (kind === undefined) {
    console.log('[seg] Fields:');
    for (const name of FIELD_KINDS) console.log(`  ${name} — ${FIELD_SPECS[name].summary}`);
    console.log("[seg] seg.field('noise') to draw one, seg.field(null) to stop.");
    return;
  }
  if (kind !== null && !isDebugFieldKind(kind)) {
    console.error(
      `[seg] seg.field: unknown field ${JSON.stringify(kind)}. Try one of: ${FIELD_KINDS.join(', ')}.`,
    );
    return;
  }
  if (!debugMatchAvailable()) return;

  drawing = kind;
  unfollow?.();
  unfollow = null;

  // Cleared locally whatever happens next, and that is not only for the way *off*: the server
  // stopping its sends leaves the last frame sitting on the scope, and a measurement that has
  // quietly stopped updating — or worse, one still wearing the previous field's colour key while
  // the new one is in flight — is the one reading a debug overlay must never give.
  useMatch.getState().clearField();

  if (kind === null) {
    useLobby.getState().setDebugField(null, null);
    console.log('[seg] Overlay off.');
    return;
  }

  request(kind);
  if (needsBoat(kind)) {
    // Re-asked on every change of selection. Zustand hands the whole state to a bare subscriber,
    // so the comparison is here rather than in a selector — one field to compare, and it saves
    // pulling in the middleware for it.
    let picked = useMatch.getState().selected;
    unfollow = useMatch.subscribe((state) => {
      if (state.selected === picked || drawing === null) return;
      picked = state.selected;
      useMatch.getState().clearField();
      request(drawing);
    });
  }

  const spec = FIELD_SPECS[kind];
  // Worth saying out loud, because all three surprise somebody the first time: the overlay is
  // ground truth over the whole map rather than what your team has heard, it is measured in units
  // the key names, and it updates more slowly than the boats drawn on top of it.
  console.log(
    `[seg] ${spec.label} (${spec.unit}): ${spec.summary}. True values over the whole map, refreshed at ${String(FIELD_MAP_HZ)} Hz.`,
  );
  // And the fourth, for the one field it applies to: a frame is not a snapshot. Said separately
  // because it is the answer to a question a developer only asks after being confused once — why
  // the overlay is deafened by a ping they cannot see anything of on the scope any more.
  if (spec.window === 'peak') {
    console.log(
      '[seg] Each frame is the worst reading since the last one, not the instant it was packed — a pulse or an impact between frames still shows.',
    );
  }
}

/** The original spelling, kept so the fingers that learned it still work. */
function noise(enabled: boolean): void {
  field(enabled === false ? null : 'noise');
}

/**
 * The ping-reach rings on or off (`@seg/shared/match/reach.ts`).
 *
 * A flag rather than a selection, unlike `seg.field`: there is one set of rings and it covers
 * every active transducer in the match at once, so there is nothing to pick and nothing to follow
 * the scope's selection with. It composes with the other two switches — rings over a field with
 * the fog thrown off is the arrangement most questions about active sonar are answered from.
 */
function reach(enabled: boolean): void {
  if (typeof enabled !== 'boolean') {
    console.error('[seg] seg.reach(enabled): enabled must be true or false.');
    return;
  }
  if (!debugMatchAvailable()) return;

  // Cleared locally on the way *off* for the reason the field is: the server stopping its sends
  // leaves the last frame's rings on the water, and rings that have quietly stopped following the
  // fleet are worse than no rings at all.
  if (!enabled) useMatch.getState().clearReach();
  useLobby.getState().setDebugReach(enabled);

  if (!enabled) {
    console.log('[seg] Ping reach rings off.');
    return;
  }
  console.log(
    '[seg] Ping reach rings on: two circles round every sub and torpedo with active sonar. Inner — how far its own pulse would show it rock. Outer — how far away the other side would hear that pulse.',
  );
  // Three things that surprise people, and all three are properties of the model rather than of
  // the drawing: the rings are what a pulse *would* do, they are open-water radii on a map where
  // sound bends, and the outer one is a fact about the enemy's ears as much as about this boat.
  console.log(
    "[seg] Drawn whether or not anything is pinging, and updated every frame. Radii are open water — sound bends round rock, so use seg.field('range') for the true shape, and a seeker only looks through its own forward arc.",
  );
}

/**
 * The probe panel on or off (`@seg/shared/match/probe.ts`).
 *
 * Purely local, and the only command here that sends the server nothing: what goes on the wire is
 * one `debug.probe` per ctrl+click (`MatchScreen`), and the server holds no notion of whether the
 * panel is open. It is still gated on the match's `debugMode` like everything else in this file —
 * a panel that opened on a production match and then refused every click would be a worse answer
 * than not opening.
 *
 * The last reading is deliberately left in place when it closes: a probe is a measurement somebody
 * took, and finding it still there on reopening is what makes the panel a notebook rather than a
 * gauge.
 */
function probe(enabled: boolean): void {
  if (typeof enabled !== 'boolean') {
    console.error('[seg] seg.probe(enabled): enabled must be true or false.');
    return;
  }
  if (!debugMatchAvailable()) return;

  useDebug.getState().setProbing(enabled);
  if (!enabled) {
    console.log('[seg] Probe off.');
    return;
  }
  console.log(
    '[seg] Probe on: ctrl+click the viewport to read that point out into the panel, bottom left.',
  );
  // The one thing that is not guessable from the panel: half of what it shows is about a *pair*,
  // so a probe with nothing selected answers about the water and nothing else.
  console.log(
    '[seg] Everything from the range down is measured against the selected boat — pick one first, or press its number key.',
  );
}

function spawn(kind: string, subtype: string, team: string): void {
  if (!debugMatchAvailable()) return;

  if (kind !== 'sub' && kind !== 'torpedo') {
    console.error(`[seg] seg.spawn: kind must be 'sub' or 'torpedo', got ${JSON.stringify(kind)}.`);
    return;
  }
  if (!isTeamId(team)) {
    console.error(
      `[seg] seg.spawn: team must be one of ${TEAM_IDS.join(', ')}, got ${JSON.stringify(team)}.`,
    );
    return;
  }
  const valid =
    kind === 'sub' ? isHullId(subtype) : isWeaponId(subtype) && isDeployableWeapon(subtype);
  if (!valid) {
    const allowed = kind === 'sub' ? HULL_IDS : DEPLOYABLE_WEAPON_IDS;
    console.error(
      `[seg] seg.spawn: unknown ${kind} subtype ${JSON.stringify(subtype)}. Try one of: ${allowed.join(', ')}.`,
    );
    return;
  }

  useDebug.getState().arm({ kind, subtype, team });
  console.log(`[seg] Click the viewport to spawn a ${team} ${subtype} ${kind}.`);
}

window.seg = { vision, field, noise, reach, probe, spawn };
