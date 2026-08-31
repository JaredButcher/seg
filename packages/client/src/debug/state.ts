/**
 * @seg/client/debug/state — the pending debug spawn.
 *
 * `debug/console.ts` arms a request from a devtools call, and `MatchScreen`/`ScopeHost` read it
 * to turn the *next* click on the viewport into a `debug.spawn` instead of an order — a small
 * zustand store rather than a bare module variable because both sides already read state this
 * way, and `MatchScreen` needs the change to trigger a render (a new `onDebugSpawn` prop).
 *
 * The probe sits here for the same reason and is otherwise its opposite: an *unarmed* switch that
 * stays on. `pendingSpawn` is one click and gone; `probing` is a mode — the panel is up and
 * ctrl+click reads a point out into it, for as long as somebody wants it there.
 *
 * Neither is on the wire and neither belongs to the match. What the *server* is told is one probe
 * request per click (`state/lobby.ts`), and it holds nothing between them.
 */

import type { DebugSpawnKind, TeamId } from '@seg/shared';
import { create } from 'zustand';

export interface DebugSpawnRequest {
  readonly kind: DebugSpawnKind;
  readonly subtype: string;
  readonly team: TeamId;
}

interface DebugStore {
  /** What the next viewport click spawns, or `null` when no spawn is armed. */
  pendingSpawn: DebugSpawnRequest | null;
  arm: (request: DebugSpawnRequest) => void;
  /** Cleared once the click that consumes it lands, or by arming a different request. */
  clear: () => void;
  /**
   * Whether the probe panel is up and ctrl+click reads a point into it (`seg.probe`).
   *
   * One flag for both halves on purpose: a panel with no way to fill it is furniture, and a
   * ctrl+click that answered into a panel nobody could see would be a keystroke that silently did
   * something. They are the same feature and they switch together.
   */
  probing: boolean;
  setProbing: (probing: boolean) => void;
}

export const useDebug = create<DebugStore>((set) => ({
  pendingSpawn: null,
  arm: (request) => set({ pendingSpawn: request }),
  clear: () => set({ pendingSpawn: null }),
  probing: false,
  setProbing: (probing) => set({ probing }),
}));
