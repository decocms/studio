/**
 * Settings sub-navigation for the sibling routes a merged sidebar row owns
 * (see `settings-tab-groups.ts`).
 *
 * Tabs are real `<Link>`s to the existing routes, so every deep link keeps
 * working and the browser's back button behaves. The route owns both portal
 * contributions: desktop uses the topbar center and compact layouts use the
 * contextual toolbar.
 */

import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Main } from "@/components/main";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import type { SettingsGroupKey } from "./settings-tab-groups";
import { useVisibleSettingsTabs } from "./use-settings-tabs";

export function SettingsSubnav({ group }: { group: SettingsGroupKey }) {
  const t = useT();
  const { org } = useParams({ from: "/shell/$org" });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tabs = useVisibleSettingsTabs()[group];
  if (tabs.length <= 1) return null;

  const renderTabs = (placement: "desktop" | "compact") => (
    <nav
      data-slot="settings-subnav"
      data-placement={placement}
      aria-label={t("settings.subnav.ariaLabel")}
      className="inline-flex h-8 min-w-0 items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {tabs.map((tab) => {
        const to = tab.to.replace("$org", org);
        const isActive = pathname === to || pathname.startsWith(`${to}/`);
        return (
          <Link
            key={tab.key}
            to={tab.to}
            params={{ org }}
            aria-current={isActive ? "page" : undefined}
            onClick={() =>
              track("settings_subnav_clicked", {
                group_key: group,
                tab_key: tab.key,
              })
            }
            className={cn(
              "inline-flex h-full min-w-0 items-center justify-center whitespace-nowrap rounded-md border border-transparent px-2.5 text-xs font-medium transition-[color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
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
  );

  return (
    <div
      data-slot="settings-heading"
      data-settings-group={group}
      className="contents"
    >
      <Main.Topbar.Center.Portal>
        <div
          data-responsive-focus-group={`settings-subnav:${group}`}
          className="hidden min-w-0 md:block"
        >
          {renderTabs("desktop")}
        </div>
      </Main.Topbar.Center.Portal>
      <Main.Toolbar.Portal visibility="compact">
        <div
          data-responsive-focus-group={`settings-subnav:${group}`}
          className="min-w-0 flex-1 overflow-x-auto md:hidden"
        >
          {renderTabs("compact")}
        </div>
      </Main.Toolbar.Portal>
    </div>
  );
}
