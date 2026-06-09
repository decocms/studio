import { OrgFilesPage } from "@/web/views/settings/files";
import { RequireCapability } from "@/web/components/require-capability";

export default function FilesRoute() {
  return (
    <RequireCapability capability="file-configs:manage" area="files">
      <OrgFilesPage />
    </RequireCapability>
  );
}
