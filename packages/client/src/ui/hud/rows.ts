/**
 * @seg/client/ui/hud/rows — joining the two halves of a match into what a panel draws.
 *
 * The protocol splits a match into a static half and a volatile one for bandwidth reasons
 * (`@seg/shared/match/view`), which is right for the wire and inconvenient for a fleet list
 * that wants a boat's name and its depth in the same row. This is where they meet.
 *
 * Pure, and separate from the components, so the arithmetic that decides "this boat is past
 * test depth" is unit-testable without a DOM.
 */

import {
  depthAt,
  type BoatProfile,
  type BoatSnapshot,
  type MatchSetup,
  type MatchViewState,
  type TeamId,
  type TubeState,
} from '@seg/shared';

/** How close a boat is to the two lines it must not cross (planning/04 §6). */
export type DepthStanding = 'safe' | 'test' | 'crush';

/**
 * The number keys that select a boat, in fleet order: 1 through 9, then 0 for the tenth.
 *
 * Ten of them and `FLEET_MAX_BOATS` is ten, so a full fleet is exactly this row of keys and no
 * boat is ever unreachable. Zero last rather than first because that is where the key sits on
 * the keyboard and where every RTS has put the tenth group since Dune II.
 */
export const SELECTION_KEYS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

/**
 * The key that selects the boat at a given position in its owner's fleet, or `null` past the
 * tenth — which the fleet validator does not allow today, but this does not assume it.
 */
export function selectionKeyFor(fleetIndex: number): string | null {
  return SELECTION_KEYS[fleetIndex] ?? null;
}

export interface FleetRow {
  readonly profile: BoatProfile;
  readonly snapshot: BoatSnapshot;
  /**
   * The number key that selects this boat, or `null` if it has none.
   *
   * Taken from the boat's position in the *fleet* rather than its position in this list, so
   * the binding a player has learned does not shift when a row is missing from a view frame.
   */
  readonly key: string | null;
  /** Empty for a teammate's boat: tube state is private to whoever commands it. */
  readonly tubes: readonly TubeState[];
  /** Metres below the surface. Derived from `pos.y`, never stored (map/types.ts). */
  readonly depth: number;
  readonly standing: DepthStanding;
  /** Fraction of maximum hit points remaining, 0..1. */
  readonly integrity: number;
  readonly cavitating: boolean;
}

/**
 * The rows for the boats this player commands, in fleet order.
 *
 * Their own boats, not the whole team's: the fleet list is the command surface (planning/08
 * §6), and at six players it would otherwise be a fifty-row list of boats the player cannot
 * order. Teammates' boats are on the scope, where their position is what matters.
 */
export function fleetRows(setup: MatchSetup, view: MatchViewState): readonly FleetRow[] {
  const snapshots = new Map(view.boats.map((boat) => [boat.id, boat]));
  const tubes = new Map(view.own.map((own) => [own.id, own.tubes]));

  return setup.fleet
    .filter((profile) => profile.owner === setup.you.accountId)
    .slice()
    .sort((a, b) => a.index - b.index)
    .flatMap((profile) => {
      const snapshot = snapshots.get(profile.id);
      if (snapshot === undefined) return [];
      const depth = depthAt(setup.map.extents, snapshot.pos.y);
      return [
        {
          profile,
          snapshot,
          key: selectionKeyFor(profile.index),
          tubes: tubes.get(profile.id) ?? [],
          depth,
          standing: standingAt(depth, profile),
          integrity: profile.stats.maxHp === 0 ? 0 : snapshot.hp / profile.stats.maxHp,
          cavitating: snapshot.cavitating,
        },
      ];
    });
}

function standingAt(depth: number, profile: BoatProfile): DepthStanding {
  if (depth >= profile.stats.crushDepth) return 'crush';
  if (depth >= profile.stats.testDepth) return 'test';
  return 'safe';
}

/** Every friendly boat on the scope, own and allied, with which is which. */
export function scopeBoats(
  setup: MatchSetup,
  view: MatchViewState,
): readonly {
  readonly id: number;
  readonly hull: BoatProfile['hull'];
  readonly pos: BoatSnapshot['pos'];
  readonly facing: number;
  readonly status: BoatSnapshot['status'];
  readonly mine: boolean;
}[] {
  const profiles = new Map(setup.fleet.map((profile) => [profile.id, profile]));

  return view.boats.flatMap((snapshot) => {
    const profile = profiles.get(snapshot.id);
    if (profile === undefined) return [];
    return [
      {
        id: snapshot.id,
        hull: profile.hull,
        pos: snapshot.pos,
        facing: snapshot.facing,
        status: snapshot.status,
        mine: profile.owner === setup.you.accountId,
      },
    ];
  });
}

// ── formatting ──────────────────────────────────────────────────────────────────────

/** `M:SS`, or `M:SS.t` inside the last ten seconds (planning/08 §11, element 5). */
export function formatClock(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const minutes = Math.floor(clamped / 60);
  const rest = clamped - minutes * 60;
  if (clamped < 10) return `${String(minutes)}:${rest.toFixed(1).padStart(4, '0')}`;
  return `${String(minutes)}:${String(Math.floor(rest)).padStart(2, '0')}`;
}

/** How urgent the clock reads: neutral, then amber, then red (planning/08 §11). */
export function clockUrgency(remainingSeconds: number): 'calm' | 'soon' | 'now' {
  if (remainingSeconds <= 60) return 'now';
  if (remainingSeconds <= 300) return 'soon';
  return 'calm';
}

/** Whole metres, with the unit. Depth is read at a glance; a decimal is noise. */
export function formatDepth(depth: number): string {
  return `${String(Math.round(depth))}m`;
}

/**
 * The pitch shown beside the depth, as a submariner reads it: `▾4°` is four degrees of down
 * angle (planning/08 §11).
 *
 * Two conversions, both of which are easy to get backwards. `facing` is counter-clockwise
 * from `+x` in a y-up frame, so a *positive* angle is nose **up** and the readout inverts it.
 * And a boat travelling left has a facing near 180°, where nose-up is 170° rather than −10°,
 * so the angle is measured against the direction of travel rather than against `+x`.
 */
export function formatPitch(facing: number): string {
  const wrapped = ((facing % 360) + 360) % 360;
  const noseUp = wrapped > 90 && wrapped < 270 ? 180 - wrapped : ((wrapped + 180) % 360) - 180;
  const down = -noseUp;
  if (Math.abs(down) < 0.5) return '—';
  return `${down > 0 ? '▾' : '▴'}${String(Math.round(Math.abs(down)))}°`;
}

/** The score a team is judged on in this mode (planning/06 §2). */
export function scoreOf(
  team: { readonly score: number; readonly survivingPoints: number },
  mode: MatchSetup['mode'],
): number {
  return mode === 'objective-capture' ? team.score : team.survivingPoints;
}

/** A team's score line, in the order the HUD shows them: yours first. */
export function orderedTeams(
  view: MatchViewState,
  you: TeamId | null,
): readonly MatchViewState['teams'][number][] {
  if (you === null) return view.teams;
  return [...view.teams].sort((a, b) => (a.team === you ? -1 : b.team === you ? 1 : 0));
}
