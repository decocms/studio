import { Page } from "@/web/components/page";
import { OrganizationForm } from "@/web/components/settings/organization-form";
import { DomainSettings } from "@/web/components/settings/domain-settings";
import { DeleteOrganizationSection } from "@/web/components/settings/delete-organization-section";
import { SettingsPage } from "@/web/components/settings/settings-section";

export function OrgGeneralPage() {
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>Organization</Page.Title>
            <OrganizationForm />
            <DomainSettings />
            <DeleteOrganizationSection />
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
