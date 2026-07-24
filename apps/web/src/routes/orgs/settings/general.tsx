import { OrgGeneralPage } from "@/views/settings/org-general";
import { RequireCapability } from "@/components/require-capability";

export default function GeneralRoute() {
  return (
    <RequireCapability capability="org:manage" area="general settings">
      <OrgGeneralPage />
    </RequireCapability>
  );
}
