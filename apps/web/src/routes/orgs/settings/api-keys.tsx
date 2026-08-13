import { OrgApiKeysPage } from "@/views/settings/api-keys";
import { RequireCapability } from "@/components/require-capability";

export default function ApiKeysRoute() {
  return (
    <RequireCapability capability="api-keys:manage" area="api-keys">
      <OrgApiKeysPage />
    </RequireCapability>
  );
}
