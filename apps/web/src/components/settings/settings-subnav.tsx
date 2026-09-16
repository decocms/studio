/**
 * Settings sub-navigation — the page heading plus a pill tab strip for the
 * sibling routes a merged sidebar row owns (see `settings-tab-groups.ts`).
 *
 * Drop-in replacement for a merged page's `<Page.Title>`. Tabs are real
 * `<Link>`s to the existing routes, so every deep link keeps working and the
 * browser's back button behaves.
 */

import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { Panel } from "@/components/panel";
import { Page } from "@/components/page";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import {
  SETTINGS_TAB_GROUPS,
  type SettingsGroupKey,
} from "./settings-tab-groups";
import { useVisibleSettingsTabs } from "./use-settings-tabs";

export function SettingsSubnav({ group }: { group: SettingsGroupKey }) {
  const t = useT();
  const { org } = useParams({ from: "/shell/$org" });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tabs = useVisibleSettingsTabs()[group];
  const { titleKey } = SETTINGS_TAB_GROUPS[group];

  return (
    <>
      <Page.Title>{t(titleKey)}</Page.Title>
      {tabs.length > 1 && (
        <Panel.Toolbar.Left.Portal>
          <Page.Tabs
            data-testid="settings-subnav"
            aria-label={t("settings.subnav.ariaLabel")}
          >
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const to = tab.to.replace("$org", org);
              const isActive = pathname === to || pathname.startsWith(`${to}/`);
              return (
                <Page.Tab key={tab.key} active={isActive} asChild>
                  <Link
                    to={tab.to}
                    params={{ org }}
                    onClick={() =>
                      track("settings_subnav_clicked", {
                        group_key: group,
                        tab_key: tab.key,
                      })
                    }
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    {t(tab.labelKey)}
                  </Link>
                </Page.Tab>
              );
            })}
          </Page.Tabs>
        </Panel.Toolbar.Left.Portal>
      )}
    </>
  );
}
