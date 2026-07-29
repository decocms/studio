import { BoardSettingsPage } from "@/views/settings/board";
import { RequireCapability } from "@/components/require-capability";

export default function BoardRoute() {
  return (
    <RequireCapability capability="org:manage" area="board settings">
      <BoardSettingsPage />
    </RequireCapability>
  );
}
