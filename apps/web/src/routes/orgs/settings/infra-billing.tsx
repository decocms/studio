import { OrgInfraBillingPage } from "@/views/settings/infra-billing";
import { RequireCapability } from "@/components/require-capability";

export default function InfraBillingRoute() {
  return (
    <RequireCapability capability="members:manage" area="billing">
      <OrgInfraBillingPage />
    </RequireCapability>
  );
}
