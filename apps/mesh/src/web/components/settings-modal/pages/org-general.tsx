import { OrganizationForm } from "@/web/components/settings/organization-form";
import { OrgDangerZone } from "@/web/components/settings/org-danger-zone";

export function OrgGeneralPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Organization
        </h2>
      </div>
      <OrganizationForm />
      <OrgDangerZone />
    </div>
  );
}
