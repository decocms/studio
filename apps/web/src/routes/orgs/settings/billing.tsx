import { OrgBillingPage } from "@/views/settings/billing";
import { RequireCapability } from "@/components/require-capability";

export default function BillingRoute() {
  return (
    <RequireCapability capability="members:manage" area="billing">
      <OrgBillingPage />
    </RequireCapability>
  );
}
