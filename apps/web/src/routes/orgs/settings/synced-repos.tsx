import { OrgSyncedReposPage } from "@/views/settings/synced-repos";
import { RequireCapability } from "@/components/require-capability";

export default function SyncedReposRoute() {
  return (
    <RequireCapability capability="file-configs:manage" area="files">
      <OrgSyncedReposPage />
    </RequireCapability>
  );
}
