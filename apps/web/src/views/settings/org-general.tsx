import { Page } from "@/components/page";
import { OrganizationForm } from "@/components/settings/organization-form";
import {
  BlocksEditorSettings,
  CodeAgentsSettings,
} from "@/components/settings/review-settings";
import { DomainSettings } from "@/components/settings/domain-settings";
import { DeleteOrganizationSection } from "@/components/settings/delete-organization-section";
import { SettingsPage } from "@/components/settings/settings-section";
import { CapabilityLoadError } from "@/components/capability-load-error";
import { useCapability } from "@/hooks/use-capability";
import { PanelLoading } from "@/layouts/main-panel-boundary";
import { useT } from "@/i18n/use-t";

/**
 * Open to every member for the blocks editor switch; the rest of the page is
 * org:manage only and isn't mounted for anyone else, so its data hooks never
 * fire for a denied member.
 */
export function OrgGeneralPage() {
  const t = useT();
  const { granted, loading, error } = useCapability("org:manage");
  if (loading) return <PanelLoading />;
  if (error) return <CapabilityLoadError />;
  return (
    <Page>
      <Page.Content>
        <Page.Container>
          <SettingsPage>
            <Page.Title>{t("settings.orgGeneral.organization")}</Page.Title>
            {granted && (
              <>
                <OrganizationForm />
                <CodeAgentsSettings />
              </>
            )}
            <BlocksEditorSettings />
            {granted && (
              <>
                <DomainSettings />
                <DeleteOrganizationSection />
              </>
            )}
          </SettingsPage>
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
