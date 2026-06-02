import { OrgBrandContextPage } from "@/web/views/settings/org-brand-context";
import { RequireCapability } from "@/web/components/require-capability";

export default function BrandContextRoute() {
  return (
    <RequireCapability capability="org:manage" area="brand context">
      <OrgBrandContextPage />
    </RequireCapability>
  );
}
