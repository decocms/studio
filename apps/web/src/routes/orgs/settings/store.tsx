import { OrgStorePage } from "@/views/settings/org-store";
import { RequireCapability } from "@/components/require-capability";

export default function StoreRoute() {
  return (
    <RequireCapability capability="registry:manage" area="the store">
      <OrgStorePage />
    </RequireCapability>
  );
}
