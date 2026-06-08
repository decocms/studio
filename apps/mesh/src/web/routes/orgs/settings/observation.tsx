import { OrgObservationPage } from "@/web/views/settings/org-observation";
import { RequireCapability } from "@/web/components/require-capability";

export default function ObservationRoute() {
  return (
    <RequireCapability
      capability="observation:manage"
      area="observation settings"
    >
      <OrgObservationPage />
    </RequireCapability>
  );
}
