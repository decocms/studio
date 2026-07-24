import { OrgSsoPage } from "@/views/settings/org-sso";
import { RequireCapability } from "@/components/require-capability";

export default function SsoRoute() {
  return (
    <RequireCapability capability="org:manage" area="security">
      <OrgSsoPage />
    </RequireCapability>
  );
}
