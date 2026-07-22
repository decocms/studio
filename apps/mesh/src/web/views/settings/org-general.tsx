import { Page } from "@/web/components/page";
import { ConnectBanner } from "@/web/components/connect/connect-banner";
import { OrganizationForm } from "@/web/components/settings/organization-form";
import { DomainSettings } from "@/web/components/settings/domain-settings";
import { DeleteOrganizationSection } from "@/web/components/settings/delete-organization-section";
import { SettingsPage } from "@/web/components/settings/settings-section";
import { useT } from "@/web/i18n/use-t";

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
            <DomainSettings />
            <DeleteOrganizationSection />
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
