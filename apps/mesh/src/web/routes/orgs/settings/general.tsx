import { OrgGeneralPage } from "@/web/views/settings/org-general";
import { RequireCapability } from "@/web/components/require-capability";

export default function GeneralRoute() {
  return (
    <RequireCapability capability="org:manage" area="general settings">
      <OrgGeneralPage />
    </RequireCapability>
  );
}
