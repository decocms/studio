import { OrgBucketsPage } from "@/web/views/settings/buckets";
import { RequireCapability } from "@/web/components/require-capability";

export default function BucketsRoute() {
  return (
    <RequireCapability capability="file-configs:manage" area="files">
      <OrgBucketsPage />
    </RequireCapability>
  );
}
