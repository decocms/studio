import { OrgBrandContextPage } from "@/views/settings/org-brand-context";
import { RequireCapability } from "@/components/require-capability";

export default function BrandContextRoute() {
  return (
    <RequireCapability capability="org:manage" area="brand context">
      <OrgBrandContextPage />
    </RequireCapability>
  );
}
