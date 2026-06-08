import { OrgObservationPage } from "@/web/views/settings/org-observation";
import { RequireCapability } from "@/web/components/require-capability";

export default function ObservationRoute() {
  return (
    <RequireCapability capability="org:manage" area="observation settings">
      <OrgObservationPage />
    </RequireCapability>
  );
}
