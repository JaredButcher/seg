import { Pending } from './Pending.js';
import { Screen } from './Screen.js';

export function BrowseLobbiesScreen() {
  return (
    <Screen title="Open lobbies">
      <Pending
        milestone="M5"
        heading="Nobody is online, because there is nothing to be online for"
        what={
          <>
            The server browser is a load-bearing screen for this game (planning/07 §4, risk R4) and
            gets built with the lobby service at M5. It will list public lobbies sorted by which is
            most likely to start soon, and say plainly how many players are online rather than
            showing an empty table with no context.
          </>
        }
      />
    </Screen>
  );
}
