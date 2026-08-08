import { Pending } from './Pending.js';
import { Screen } from './Screen.js';

export function FleetEditorScreen() {
  return (
    <Screen title="Fleet editor">
      <Pending
        milestone="M5"
        heading="There is nothing to build a fleet out of yet"
        what={
          <>
            The editor is driven entirely by the content tables — five hulls, their modules, and the
            torpedo variants — which are an M3 deliverable (planning/05). The editor itself, with
            its live stat, detection-range, and depth-envelope previews, follows at M5.
          </>
        }
      />
    </Screen>
  );
}
