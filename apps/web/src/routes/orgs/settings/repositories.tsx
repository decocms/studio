import { OrgRepositoriesPage } from "@/views/settings/repositories";
import { RequireCapability } from "@/components/require-capability";

export default function RepositoriesRoute() {
  return (
    <RequireCapability capability="file-configs:manage" area="files">
      <OrgRepositoriesPage />
    </RequireCapability>
  );
}
