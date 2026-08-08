import { Pending } from './Pending.js';
import { Screen } from './Screen.js';

export function CreateLobbyScreen() {
  return (
    <Screen title="Create a lobby">
      <Pending
        milestone="M5"
        heading="Hosting is not wired up yet"
        what={
          <>
            The host settings panel — mode, map seed, terrain density, team size, point budget,
            spectator policy (planning/06 §3) — needs the lobby service and the map generator behind
            it. The generator is M1; the lobby is M5.
          </>
        }
      />
    </Screen>
  );
}
