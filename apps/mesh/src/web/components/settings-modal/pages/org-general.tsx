import { OrganizationForm } from "@/web/components/settings/organization-form";

export function OrgGeneralPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Organization
        </h2>
      </div>
      <OrganizationForm />
    </div>
  );
}
