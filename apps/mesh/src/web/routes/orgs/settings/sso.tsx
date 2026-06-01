import { OrgSsoPage } from "@/web/views/settings/org-sso";
import { RequireCapability } from "@/web/components/require-capability";

export default function SsoRoute() {
  return (
    <RequireCapability capability="org:manage" area="security">
      <OrgSsoPage />
    </RequireCapability>
  );
}
