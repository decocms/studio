import { OrgBucketsPage } from "@/views/settings/buckets";
import { RequireCapability } from "@/components/require-capability";

export default function BucketsRoute() {
  return (
    <RequireCapability capability="file-configs:manage" area="files">
      <OrgBucketsPage />
    </RequireCapability>
  );
}
