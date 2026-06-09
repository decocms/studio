import { OrgStorePage } from "@/web/views/settings/org-store";
import { RequireCapability } from "@/web/components/require-capability";

export default function StoreRoute() {
  return (
    <RequireCapability capability="registry:manage" area="the store">
      <OrgStorePage />
    </RequireCapability>
  );
}
