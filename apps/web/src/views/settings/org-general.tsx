import { Main } from "@/components/main";
import { OrganizationForm } from "@/components/settings/organization-form";
import { CodeAgentsSettings } from "@/components/settings/review-settings";
import { DomainSettings } from "@/components/settings/domain-settings";
import { DeleteOrganizationSection } from "@/components/settings/delete-organization-section";

export function OrgGeneralPage() {
  return (
    <div className="h-full overflow-y-auto">
      <Main.Container width="standard">
        <Main.Stack gap="spacious">
          <OrganizationForm />
          <CodeAgentsSettings />
          <DomainSettings />
          <DeleteOrganizationSection />
        </Main.Stack>
      </Main.Container>
    </div>
  );
}
