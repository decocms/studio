import { Page } from "@/components/page";
import { ConnectBanner } from "@/components/connect/connect-banner";
import { OrganizationForm } from "@/components/settings/organization-form";
import { MainAgentSettings } from "@/components/settings/main-agent-settings";
import { NavigationSettings } from "@/components/settings/navigation-settings";
import { DomainSettings } from "@/components/settings/domain-settings";
import { DeleteOrganizationSection } from "@/components/settings/delete-organization-section";
import { SettingsPage } from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t";

export function OrgGeneralPage() {
  const t = useT();
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>{t("settings.orgGeneral.organization")}</Page.Title>
            <ConnectBanner />
            <OrganizationForm />
            <MainAgentSettings />
            <NavigationSettings />
            <DomainSettings />
            <DeleteOrganizationSection />
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
