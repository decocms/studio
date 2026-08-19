/**
 * Settings sub-navigation — the page heading plus a pill tab strip for the
 * sibling routes a merged sidebar row owns (see `settings-tab-groups.ts`).
 *
 * Drop-in replacement for a merged page's `<Page.Title>`. Tabs are real
 * `<Link>`s to the existing routes, so every deep link keeps working and the
 * browser's back button behaves.
 */

import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Page } from "@/components/page";
import { useCapabilities } from "@/hooks/use-capability";
import { useOwnedSites } from "@/hooks/use-infra-billing";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import {
  SETTINGS_TAB_GROUPS,
  type SettingsGroupKey,
  type SettingsTabDef,
} from "./settings-tab-groups";

/**
 * The tabs of `group` the current member may open. Mirrors the sidebar's
 * optimistic-while-loading rule: show everything until capabilities resolve so
 * owners never see the strip flicker.
 */
function useVisibleTabs(group: SettingsGroupKey): SettingsTabDef[] {
  const { capabilities, isPrivileged, loading, error } = useCapabilities();
  const ownsSites = useOwnedSites().sites.length > 0;
  const { tabs } = SETTINGS_TAB_GROUPS[group];

  return tabs.filter((tab) => {
    if (tab.requiresOwnedSites && !ownsSites) return false;
    if (loading || error) return true;
    if (tab.privilegedOnly) return isPrivileged;
    if (!tab.requires) return true;
    return isPrivileged || capabilities[tab.requires];
  });
}

export function SettingsSubnav({ group }: { group: SettingsGroupKey }) {
  const t = useT();
  const { org } = useParams({ from: "/shell/$org" });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tabs = useVisibleTabs(group);
  const { titleKey } = SETTINGS_TAB_GROUPS[group];

  return (
    <div className="flex flex-col gap-4">
      <Page.Title>{t(titleKey)}</Page.Title>
      {tabs.length > 1 && (
        <nav
          data-slot="settings-subnav"
          aria-label={t("settings.subnav.ariaLabel")}
          className="bg-muted inline-flex h-10 w-fit items-center rounded-xl p-[3px] gap-0.5"
        >
          {tabs.map((tab) => {
            const to = tab.to.replace("$org", org);
            const isActive = pathname === to || pathname.startsWith(`${to}/`);
            return (
              <Link
                key={tab.key}
                to={tab.to}
                params={{ org }}
                onClick={() =>
                  track("settings_subnav_clicked", {
                    group_key: group,
                    tab_key: tab.key,
                  })
                }
                className={cn(
                  "inline-flex h-full items-center justify-center rounded-lg border border-transparent px-3 text-sm font-medium whitespace-nowrap transition-[color,box-shadow]",
                  isActive
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(tab.labelKey)}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
