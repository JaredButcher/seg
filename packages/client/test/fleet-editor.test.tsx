/**
 * @vitest-environment jsdom
 *
 * The fleet editor's behaviour: which slots a hull offers, what a module does to the stat
 * panel, and that the editor can only build fleets the server would accept.
 *
 * The API is stubbed — persistence is covered against the real server in the server package's
 * fleets.test.ts. What is covered here is the editing model.
 */
import { HULLS, MODULES } from '@seg/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuth } from '../src/state/auth.js';
import { useFleet } from '../src/state/fleet.js';
import { useLobby } from '../src/state/lobby.js';
import { useNav } from '../src/state/nav.js';
import { FleetEditorScreen } from '../src/ui/FleetEditorScreen.js';

const ACCOUNT = { id: 'a1', username: 'Admiral', createdAt: 0 };

/** jsdom does not implement <dialog>; the pickers rely on showModal/close. */
function stubDialog() {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}

beforeEach(() => {
  stubDialog();
  useAuth.setState({ status: 'signedIn', account: ACCOUNT, session: null });
  useLobby.setState({ lobby: null });
  useNav.setState({ screen: 'fleet-editor', authTab: 'signIn' });
  useFleet.setState({
    draftName: 'Test Fleet',
    boats: [],
    savedId: null,
    selected: null,
    saved: [],
    dirty: false,
    busy: false,
    loading: false,
    error: null,
    savedAt: null,
    refreshSaved: vi.fn(async () => undefined),
  });
});

afterEach(cleanup);

/** The right-hand panel, so slot and stat queries do not also match the boat list. */
function boatPanel() {
  return screen.getByRole('heading', { name: /^(Light|Medium|Heavy)$/ }).closest('section')!;
}

function statRow(label: string) {
  return screen.getByRole('rowheader', { name: label }).closest('tr')!;
}

async function addBoat(user: ReturnType<typeof userEvent.setup>, hull: string) {
  await user.click(screen.getByRole('button', { name: 'ADD BOAT' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: new RegExp(`^${hull}`) }));
}

describe('adding boats', () => {
  it('offers every hull, with its cost', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);

    await user.click(screen.getByRole('button', { name: 'ADD BOAT' }));
    const dialog = await screen.findByRole('dialog');

    for (const hull of Object.values(HULLS)) {
      expect(within(dialog).getByRole('button', { name: new RegExp(hull.name) })).toBeDefined();
      expect(within(dialog).getByText(`${hull.cost} pts`)).toBeDefined();
    }
  });

  it('adds the chosen hull and selects it', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);

    await addBoat(user, 'Heavy');

    expect(useFleet.getState().boats).toHaveLength(1);
    expect(useFleet.getState().boats[0]?.hull).toBe('heavy');
    // Selected, so the right-hand panel is not blank after adding.
    expect(useFleet.getState().selected).toBe(0);
  });

  it('names boats S-01, S-02 without repeating', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);

    await addBoat(user, 'Light');
    await addBoat(user, 'Light');

    expect(useFleet.getState().boats.map((b) => b.name)).toEqual(['S-01', 'S-02']);
  });

  it('runs the fleet total from the shared cost function', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);

    await addBoat(user, 'Light');
    await addBoat(user, 'Heavy');

    expect(screen.getByText(String(HULLS.light.cost + HULLS.heavy.cost))).toBeDefined();
  });
});

describe('slots', () => {
  it('shows exactly the slots the hull declares', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);
    await addBoat(user, 'Heavy');

    const slots = within(boatPanel()).getAllByRole('button', { name: /Equipment|Weapon/ });
    expect(slots).toHaveLength(HULLS.heavy.slots.equipment + HULLS.heavy.slots.weapon);
  });

  it('offers only modules that fit that slot kind', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);
    await addBoat(user, 'Medium');

    await user.click(within(boatPanel()).getAllByRole('button', { name: /Equipment/ })[0]!);
    const dialog = await screen.findByRole('dialog');

    // A weapon module must not be offered for an equipment slot — the shared table decides,
    // so the editor can never build a fleet the server refuses.
    expect(within(dialog).queryByText(MODULES['extra-tube'].name)).toBeNull();
    expect(within(dialog).getByText(MODULES['silent-running-gear'].name)).toBeDefined();
  });

  it('fits a module and records it against that slot', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);
    await addBoat(user, 'Medium');

    await user.click(within(boatPanel()).getAllByRole('button', { name: /Weapon/ })[1]!);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Extra Torpedo Tube/ }));

    expect(useFleet.getState().boats[0]?.modules).toEqual([
      { slot: 'weapon', index: 1, module: 'extra-tube' },
    ]);
  });

  it('replaces rather than stacks when a filled slot is refitted', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);
    await addBoat(user, 'Medium');

    const slot = () => within(boatPanel()).getAllByRole('button', { name: /Weapon/ })[0]!;
    await user.click(slot());
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /Extra Torpedo Tube/ }),
    );
    await user.click(slot());
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /Rapid Loader/ }),
    );

    const modules = useFleet.getState().boats[0]?.modules ?? [];
    expect(modules).toHaveLength(1);
    expect(modules[0]?.module).toBe('rapid-loader');
  });

  it('offers to empty a filled slot, and does', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);
    await addBoat(user, 'Medium');

    const slot = () => within(boatPanel()).getAllByRole('button', { name: /Weapon/ })[0]!;
    await user.click(slot());
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /Extra Torpedo Tube/ }),
    );

    await user.click(slot());
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /Empty this slot/ }),
    );

    expect(useFleet.getState().boats[0]?.modules).toHaveLength(0);
  });

  it('says when a module’s benefit only applies under some condition', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);
    await addBoat(user, 'Medium');

    await user.click(within(boatPanel()).getAllByRole('button', { name: /Equipment/ })[0]!);
    const dialog = await screen.findByRole('dialog');

    // The towed array's whole trade is that it only pays off at the slow notch — the one thing
    // a player fitting it blind could not otherwise know without reading match/conditions.ts.
    // Both of its modifiers carry the condition, so it is said twice, once per stat it touches.
    const row = within(dialog).getByText(MODULES['towed-array'].name).closest('button')!;
    expect(within(row).getAllByText(/Only at SLOW throttle/)).toHaveLength(2);

    // A module with no condition says nothing of the kind.
    const unconditional = within(dialog)
      .getByText(MODULES['silent-running-gear'].name)
      .closest('button')!;
    expect(within(unconditional).queryByText(/Only at/)).toBeNull();
  });
});

describe('the stat panel', () => {
  it('shows base and fitted side by side', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);
    await addBoat(user, 'Heavy');

    // Scoped to the cells: an unmodified stat shows the same number in both columns, so a
    // bare text query would be ambiguous — which is itself the thing being asserted.
    const row = statRow('Hull integrity');
    expect(row.querySelector('.stats__base')?.textContent).toBe(`${HULLS.heavy.stats.maxHp} hp`);
    expect(row.querySelector('.stats__current')?.textContent).toBe(`${HULLS.heavy.stats.maxHp} hp`);
  });

  it('updates the fitted column when a module goes in', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);
    await addBoat(user, 'Heavy');

    await user.click(within(boatPanel()).getAllByRole('button', { name: /Equipment/ })[0]!);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /Armor Plating/ }),
    );

    // 185 × 1.6 = 296.
    await waitFor(() => {
      expect(within(statRow('Hull integrity')).getByText(/296 hp/)).toBeDefined();
    });
  });

  it('marks a change as better or worse, not merely as changed', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);
    await addBoat(user, 'Heavy');

    await user.click(within(boatPanel()).getAllByRole('button', { name: /Equipment/ })[0]!);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /Armor Plating/ }),
    );

    await waitFor(() => {
      // More hull is better…
      expect(
        statRow('Hull integrity').querySelector('.stats__current')?.getAttribute('data-better'),
      ).toBe('true');
    });
    // …and the knot of speed it costs is not. Getting this backwards would tell a player a
    // silencing module made them louder.
    expect(statRow('Max speed').querySelector('.stats__current')?.getAttribute('data-better')).toBe(
      'false',
    );
  });

  it('leaves untouched stats unmarked', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);
    await addBoat(user, 'Heavy');

    expect(statRow('Turn rate').getAttribute('data-changed')).toBe('false');
  });
});

describe('editing the fleet', () => {
  it('renames a boat, and the list follows', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);
    await addBoat(user, 'Light');

    const field = screen.getByLabelText('Boat name');
    await user.clear(field);
    await user.type(field, 'Nautilus');

    expect(useFleet.getState().boats[0]?.name).toBe('Nautilus');
  });

  it('removes a boat by name', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);
    await addBoat(user, 'Light');
    await addBoat(user, 'Heavy');

    await user.click(screen.getByRole('button', { name: 'Remove S-01 from the fleet' }));

    expect(useFleet.getState().boats).toHaveLength(1);
    expect(useFleet.getState().boats[0]?.name).toBe('S-02');
  });

  it('marks the draft unsaved as soon as it is touched', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);
    expect(useFleet.getState().dirty).toBe(false);

    await addBoat(user, 'Light');

    expect(useFleet.getState().dirty).toBe(true);
    expect(screen.getByText('UNSAVED')).toBeDefined();
  });

  it('cannot save an empty fleet', () => {
    render(<FleetEditorScreen />);
    const save = screen.getByRole('button', { name: 'SAVE' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});

describe('the load list', () => {
  it('shows each saved fleet with its boat count and points', async () => {
    const user = userEvent.setup();
    useFleet.setState({
      saved: [
        { id: 'f1', name: 'First Wolfpack', boatCount: 3, points: 410, updatedAt: 0 },
        { id: 'f2', name: 'Deep Patrol', boatCount: 1, points: 190, updatedAt: 0 },
      ],
    });
    render(<FleetEditorScreen />);

    await user.click(screen.getByRole('button', { name: 'LOAD' }));

    expect(screen.getByText('First Wolfpack')).toBeDefined();
    expect(screen.getByText(/3 boats · 410 pts/)).toBeDefined();
    // Singular, because "1 boats" is the kind of thing players notice.
    expect(screen.getByText(/1 boat · 190 pts/)).toBeDefined();
  });

  it('warns when loading would discard unsaved work', async () => {
    const user = userEvent.setup();
    useFleet.setState({
      dirty: true,
      saved: [{ id: 'f1', name: 'Saved', boatCount: 1, points: 70, updatedAt: 0 }],
    });
    render(<FleetEditorScreen />);

    await user.click(screen.getByRole('button', { name: 'LOAD' }));

    expect(screen.getByText(/unsaved changes/i)).toBeDefined();
  });

  it('asks twice before deleting', async () => {
    const user = userEvent.setup();
    const deleteFleet = vi.fn(async () => undefined);
    useFleet.setState({
      saved: [{ id: 'f1', name: 'Doomed', boatCount: 1, points: 70, updatedAt: 0 }],
      deleteFleet,
    });
    render(<FleetEditorScreen />);
    await user.click(screen.getByRole('button', { name: 'LOAD' }));

    await user.click(screen.getByRole('button', { name: 'Delete the fleet Doomed' }));
    expect(deleteFleet).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'CONFIRM' }));
    expect(deleteFleet).toHaveBeenCalledWith('f1');
  });

  it('loads the chosen fleet', async () => {
    const user = userEvent.setup();
    const loadFleet = vi.fn(async () => undefined);
    useFleet.setState({
      saved: [{ id: 'f1', name: 'First Wolfpack', boatCount: 2, points: 260, updatedAt: 0 }],
      loadFleet,
    });
    render(<FleetEditorScreen />);
    await user.click(screen.getByRole('button', { name: 'LOAD' }));

    await user.click(screen.getByRole('button', { name: /^First Wolfpack/ }));

    expect(loadFleet).toHaveBeenCalledWith('f1');
  });
});

describe('where back goes', () => {
  it('returns to the menu when opened from the menu', async () => {
    const user = userEvent.setup();
    render(<FleetEditorScreen />);

    await user.click(screen.getByRole('button', { name: /MAIN MENU/ }));

    expect(useNav.getState().screen).toBe('home');
  });

  it('returns to the lobby when opened from a lobby', async () => {
    const user = userEvent.setup();
    // Fleets are chosen against a known map, so the editor is reachable from inside a lobby
    // — and going "back" to the menu from there would strand the player.
    useLobby.setState({
      lobby: {
        id: 'l1',
        code: 'BCDFGH',
        hostAccountId: 'a1',
        settings: {
          name: 'Lobby',
          maxPlayers: 6,
          mode: 'objective-capture',
          fleetPoints: 500,
          visibility: 'public',
          mapType: 'dense',
          mapSize: 'medium',
          debugMode: false,
        },
        members: [],
        createdAt: 0,
      },
    });
    render(<FleetEditorScreen />);

    await user.click(screen.getByRole('button', { name: /BACK TO LOBBY/ }));

    expect(useNav.getState().screen).toBe('lobby');
  });
});

describe('the lobby budget', () => {
  /** Puts the editor inside a lobby with the given point budget. */
  function inLobby(fleetPoints: number) {
    useLobby.setState({
      lobby: {
        id: 'l1',
        code: 'BCDFGH',
        hostAccountId: 'a1',
        settings: {
          name: 'Lobby',
          maxPlayers: 6,
          mode: 'objective-capture',
          fleetPoints,
          visibility: 'public',
          mapType: 'dense',
          mapSize: 'medium',
          debugMode: false,
        },
        members: [],
        createdAt: 0,
      },
    });
  }

  it('is not shown outside a lobby, where there is no budget to measure against', () => {
    render(<FleetEditorScreen />);
    expect(screen.queryByText(/LOBBY BUDGET/)).toBeNull();
  });

  it('shows the budget and what is left of it', () => {
    inLobby(500);
    // One Heavy: 200 of 500.
    useFleet.setState({ boats: [{ name: 'S-01', hull: 'heavy', modules: [] }], selected: 0 });
    render(<FleetEditorScreen />);

    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('500');
    expect(banner.textContent).toContain('300 left');
    expect(banner.getAttribute('data-over')).toBe('false');
  });

  it('warns, and says by how much, once the fleet is over', () => {
    inLobby(200);
    useFleet.setState({
      boats: [
        { name: 'S-01', hull: 'heavy', modules: [] },
        { name: 'S-02', hull: 'heavy', modules: [] },
      ],
      selected: 0,
    });
    render(<FleetEditorScreen />);

    const banner = screen.getByRole('status');
    // 200 + 200 = 400 against 200. Naming the overshoot is the difference between a warning
    // the player can act on and one they have to do arithmetic for.
    expect(banner.getAttribute('data-over')).toBe('true');
    expect(banner.textContent).toContain('200 over');
  });
});
