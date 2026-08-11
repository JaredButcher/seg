/**
 * @seg/client/debug/state — the pending debug spawn.
 *
 * `debug/console.ts` arms a request from a devtools call, and `MatchScreen`/`ScopeHost` read it
 * to turn the *next* click on the viewport into a `debug.spawn` instead of an order — a small
 * zustand store rather than a bare module variable because both sides already read state this
 * way, and `MatchScreen` needs the change to trigger a render (a new `onDebugSpawn` prop).
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
}

export const useDebug = create<DebugStore>((set) => ({
  pendingSpawn: null,
  arm: (request) => set({ pendingSpawn: request }),
  clear: () => set({ pendingSpawn: null }),
}));
