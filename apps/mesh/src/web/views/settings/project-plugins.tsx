import { Page } from "@/web/components/page";
import { ProjectPluginsForm } from "@/web/components/settings/project-plugins-form";
import { SettingsPage } from "@/web/components/settings/settings-section";

export function ProjectPluginsPage() {
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>Plugins</Page.Title>
            <ProjectPluginsForm />
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
