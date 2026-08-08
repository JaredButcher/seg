import {
  FLEET_MAX_BOATS,
  getHull,
  type BoatTemplate,
  type FittedModule,
  type Fleet,
  type FleetId,
  type FleetSummary,
  type HullId,
  type ModuleId,
  type SlotKind,
} from '@seg/shared';
import { create } from 'zustand';

import { fleetApi } from '../api/fleets.js';

/**
 * The fleet editor's working copy.
 *
 * The draft lives here rather than in the screen, for two reasons: the editor is reachable
 * from the main menu *and* from a lobby (planning/07 §3), and a half-built fleet must survive
 * navigating between them; and `dirty` has to be answerable from outside the editor so
 * leaving can warn.
 *
 * Nothing here computes stats or costs — that is `resolveBoat`/`fleetCost` in @seg/shared,
 * the same functions the server validates with.
 */

interface FleetStore {
  /** `null` until the editor is opened. */
  draftName: string;
  boats: BoatTemplate[];
  /** The saved fleet this draft came from, or `null` for a new one. */
  savedId: FleetId | null;
  /** Which boat the editor is showing. Index into `boats`. */
  selected: number | null;

  saved: readonly FleetSummary[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  /** Set after a successful save, so the UI can say so without inventing a toast system. */
  savedAt: number | null;

  dirty: boolean;

  newFleet: () => void;
  refreshSaved: () => Promise<void>;
  loadFleet: (id: FleetId) => Promise<void>;
  saveFleet: () => Promise<void>;
  deleteFleet: (id: FleetId) => Promise<void>;

  setFleetName: (name: string) => void;
  addBoat: (hull: HullId) => void;
  removeBoat: (index: number) => void;
  selectBoat: (index: number | null) => void;
  renameBoat: (index: number, name: string) => void;
  fitModule: (slot: SlotKind, slotIndex: number, module: ModuleId) => void;
  clearSlot: (slot: SlotKind, slotIndex: number) => void;
  clearError: () => void;
}

const EMPTY: Pick<FleetStore, 'draftName' | 'boats' | 'savedId' | 'selected' | 'dirty'> = {
  draftName: '',
  boats: [],
  savedId: null,
  selected: null,
  dirty: false,
};

/** "S-01", "S-02"… the designation style the scope uses. */
function nextBoatName(boats: readonly BoatTemplate[]): string {
  const used = new Set(boats.map((b) => b.name));
  for (let n = 1; n <= FLEET_MAX_BOATS + 1; n += 1) {
    const name = `S-${String(n).padStart(2, '0')}`;
    if (!used.has(name)) return name;
  }
  return `S-${String(boats.length + 1)}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export const useFleet = create<FleetStore>((set, get) => {
  /** Every edit marks the draft dirty and clears the "saved" flash. */
  const edit = (patch: Partial<FleetStore>) => set({ ...patch, dirty: true, savedAt: null });

  return {
    ...EMPTY,
    saved: [],
    loading: false,
    busy: false,
    error: null,
    savedAt: null,

    newFleet: () => set({ ...EMPTY, draftName: 'New fleet', error: null, savedAt: null }),

    async refreshSaved() {
      set({ loading: true });
      try {
        set({ saved: await fleetApi.list(), error: null });
      } catch (err) {
        set({ error: message(err) });
      } finally {
        set({ loading: false });
      }
    },

    async loadFleet(id) {
      set({ busy: true });
      try {
        const fleet: Fleet = await fleetApi.load(id);
        set({
          draftName: fleet.name,
          boats: [...fleet.boats],
          savedId: fleet.id,
          // Opening a fleet with a boat already selected is what the player almost always
          // wants next, and it saves the editor from rendering an empty right-hand panel.
          selected: fleet.boats.length > 0 ? 0 : null,
          dirty: false,
          error: null,
          savedAt: null,
        });
      } catch (err) {
        set({ error: message(err) });
      } finally {
        set({ busy: false });
      }
    },

    async saveFleet() {
      const { savedId, draftName, boats } = get();
      set({ busy: true, error: null });
      try {
        const fleet =
          savedId === null
            ? await fleetApi.create(draftName, boats)
            : await fleetApi.update(savedId, draftName, boats);

        // Adopt what the server stored, not what was sent: it normalises names and drops
        // modules the content tables no longer accept, and the editor should show that.
        set({
          savedId: fleet.id,
          draftName: fleet.name,
          boats: [...fleet.boats],
          dirty: false,
          savedAt: Date.now(),
        });
        await get().refreshSaved();
      } catch (err) {
        set({ error: message(err) });
      } finally {
        set({ busy: false });
      }
    },

    async deleteFleet(id) {
      set({ busy: true });
      try {
        await fleetApi.remove(id);
        // Deleting the fleet currently open leaves the draft in place but detached, so the
        // player does not lose their work to a misclick — the next save creates a new one.
        if (get().savedId === id) set({ savedId: null, dirty: true });
        await get().refreshSaved();
        set({ error: null });
      } catch (err) {
        set({ error: message(err) });
      } finally {
        set({ busy: false });
      }
    },

    setFleetName: (name) => edit({ draftName: name }),

    addBoat: (hull) => {
      const { boats } = get();
      if (boats.length >= FLEET_MAX_BOATS) {
        set({ error: `A fleet can hold at most ${String(FLEET_MAX_BOATS)} boats.` });
        return;
      }
      const boat: BoatTemplate = { name: nextBoatName(boats), hull, modules: [] };
      edit({ boats: [...boats, boat], selected: boats.length, error: null });
    },

    removeBoat: (index) => {
      const { boats, selected } = get();
      const next = boats.filter((_, i) => i !== index);
      // Keep a sensible selection: stay put if something took the slot, otherwise step back.
      const nextSelected =
        next.length === 0 ? null : selected === null ? null : Math.min(selected, next.length - 1);
      edit({ boats: next, selected: nextSelected });
    },

    selectBoat: (index) => set({ selected: index }),

    renameBoat: (index, name) => {
      const boats = get().boats.map((b, i) => (i === index ? { ...b, name } : b));
      edit({ boats });
    },

    fitModule: (slot, slotIndex, module) => {
      const { boats, selected } = get();
      if (selected === null) return;

      const next = boats.map((boat, i) => {
        if (i !== selected) return boat;
        // Replace rather than append: one module per slot, enforced here as well as by
        // the shared validator, so the editor can never build a fleet the server refuses.
        const modules: FittedModule[] = [
          ...boat.modules.filter((m) => !(m.slot === slot && m.index === slotIndex)),
          { slot, index: slotIndex, module },
        ];
        return { ...boat, modules };
      });

      edit({ boats: next });
    },

    clearSlot: (slot, slotIndex) => {
      const { boats, selected } = get();
      if (selected === null) return;

      const next = boats.map((boat, i) =>
        i !== selected
          ? boat
          : {
              ...boat,
              modules: boat.modules.filter((m) => !(m.slot === slot && m.index === slotIndex)),
            },
      );
      edit({ boats: next });
    },

    clearError: () => set({ error: null }),
  };
});

/** The hull a boat sits on, for callers that only have the template. */
export function hullOf(boat: BoatTemplate) {
  return getHull(boat.hull);
}
