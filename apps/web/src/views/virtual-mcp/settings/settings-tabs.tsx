import { Link } from "@tanstack/react-router";
import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import { useT } from "@/i18n/use-t";
import {
  PROJECT_SETTINGS_SECTION_KEYS,
  PROJECT_SETTINGS_SECTIONS,
  type ProjectSettingsSectionKey,
} from "./sections";

export function ProjectSettingsTabs({
  section,
}: {
  section: ProjectSettingsSectionKey;
}) {
  const t = useT();
  const tabs = (
    <Page.Tabs aria-label={t("virtualMcp.settings.navigation")}>
      {PROJECT_SETTINGS_SECTION_KEYS.map((key) => {
        const { icon: Icon, titleKey } = PROJECT_SETTINGS_SECTIONS[key];
        return (
          <Page.Tab key={key} active={section === key} asChild>
            <Link
              to="."
              activeOptions={{ exact: true, explicitUndefined: true }}
              search={(previous) => ({
                ...previous,
                section: key === "general" ? undefined : key,
              })}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              {t(titleKey)}
            </Link>
          </Page.Tab>
        );
      })}
    </Page.Tabs>
  );
  return (
    <Panel.Toolbar.Left.Portal fallback={tabs}>
      {tabs}
    </Panel.Toolbar.Left.Portal>
  );
}
