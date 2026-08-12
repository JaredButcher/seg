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
 * Three commands:
 *
 * - `seg.vision(true | false)` — spectator-style live vision: both fleets, true position, fog
 *   of war off, while the player still only *commands* their own team. Sent immediately.
 * - `seg.noise(true | false)` — the acoustic noise heatmap, drawn under the whole scope: the
 *   summed sound power at every point in the water, which is what lights the walls and what a
 *   listener has to be heard over (`@seg/shared/match/noise.ts`). The one debug view that shows
 *   the model itself rather than its output, and the reason it is worth a protocol message: it
 *   answers "why did nothing detect that" directly, where the sonar picture can only show that
 *   nothing did.
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
  isTeamId,
  isWeaponId,
  NOISE_MAP_HZ,
  type DebugSpawnKind,
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
      noise(enabled: boolean): void;
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

function noise(enabled: boolean): void {
  if (typeof enabled !== 'boolean') {
    console.error('[seg] seg.noise(enabled): enabled must be true or false.');
    return;
  }
  if (!debugMatchAvailable()) return;

  useLobby.getState().setDebugNoise(enabled);
  // Worth saying out loud, because both facts surprise somebody the first time: the overlay is
  // ground truth over the whole map — it is not gated on what your team has heard — and it
  // updates more slowly than the boats drawn on top of it (`NOISE_MAP_HZ`).
  console.log(
    enabled
      ? `[seg] Noise heatmap on: true levels over the whole map, refreshed at ${String(NOISE_MAP_HZ)} Hz.`
      : '[seg] Noise heatmap off.',
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

window.seg = { vision, noise, spawn };
