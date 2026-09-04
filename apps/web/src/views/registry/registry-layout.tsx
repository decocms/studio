import { useState, type ComponentType } from "react";
import { CheckCircle, Container, Settings02, Tool02 } from "@untitledui/icons";
import { PLUGIN_ID } from "@decocms/shared/registry/constants";
import { useBrokenMonitorsCount } from "@/hooks/registry/use-monitor";
import {
  usePublishRequestCount,
  useRegistryConfig,
} from "@/hooks/registry/use-registry";
import { useT } from "@/i18n/use-t.ts";
import { Main } from "@/components/main";
import { MainBreadcrumb } from "@/components/main-breadcrumb";
import { CollectionTabs } from "@/components/collections/collection-tabs.tsx";
import { useProjectContext } from "@/sdk";
import RegistryItemsPage from "./registry-items-page";
import RegistryRequestsPage from "./registry-requests-page";
import RegistrySettingsPage from "./registry-settings-page";
import RegistryMonitorPage from "./registry-monitor-page";

type NavItem = {
  id: string;
  label: string;
  count?: number;
  icon: ComponentType<{ size?: number; className?: string }>;
  tab: "items" | "requests" | "qa" | "settings";
};

function RegistryTabs({
  activeTab,
  onChange,
  items,
  ariaLabel,
}: {
  activeTab: NavItem["tab"];
  onChange: (tab: NavItem["tab"]) => void;
  items: NavItem[];
  ariaLabel: string;
}) {
  return (
    <CollectionTabs
      ariaLabel={ariaLabel}
      activeTab={activeTab}
      onTabChange={(next) => {
        if (
          next === "items" ||
          next === "requests" ||
          next === "qa" ||
          next === "settings"
        ) {
          onChange(next);
        }
      }}
      tabs={items.map((item) => {
        const Icon = item.icon;
        return {
          id: item.tab,
          count: item.count,
          label: (
            <>
              <Icon aria-hidden="true" size={14} />
              <span>{item.label}</span>
            </>
          ),
        };
      })}
    />
  );
}

export default function RegistryLayout({
  activeTab,
  onTabChange,
}: {
  activeTab: NavItem["tab"];
  onTabChange: (tab: NavItem["tab"]) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const { registryName, registryIcon, acceptPublishRequests } =
    useRegistryConfig(PLUGIN_ID);
  const pendingQuery = usePublishRequestCount();
  const brokenMonitors = useBrokenMonitorsCount();

  const visibleTab =
    !acceptPublishRequests && activeTab === "requests" ? "items" : activeTab;

  const pendingCount = pendingQuery.data?.pending ?? 0;
  const navItems: NavItem[] = [
    {
      id: "items",
      label: t("registry.registryLayout.itemsTab"),
      icon: Container,
      tab: "items",
      count:
        brokenMonitors.brokenCount > 0 ? brokenMonitors.brokenCount : undefined,
    },
    ...(acceptPublishRequests
      ? [
          {
            id: "requests",
            label: t("registry.registryLayout.requestsTab"),
            icon: CheckCircle,
            tab: "requests" as const,
            count: pendingCount,
          },
        ]
      : []),
    {
      id: "qa",
      label: t("registry.registryLayout.qaTab"),
      icon: Tool02,
      tab: "qa",
    },
    {
      id: "settings",
      label: t("registry.registryLayout.settingsTab"),
      icon: Settings02,
      tab: "settings",
    },
  ];

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      <MainBreadcrumb.Parent.Portal
        item={{
          id: "settings:store",
          label: t("settings.nav.store"),
          link: {
            to: "/$org/settings/store",
            params: { org: org.slug },
          },
        }}
      />
      <Main.Title.Portal>
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {registryIcon ? (
            <img
              src={registryIcon}
              alt=""
              className="size-5 shrink-0 rounded object-cover"
            />
          ) : null}
          <span className="truncate" title={registryName}>
            {registryName}
          </span>
        </span>
      </Main.Title.Portal>
      <Main.Topbar.Center.Portal>
        <div className="hidden md:block">
          <RegistryTabs
            activeTab={visibleTab}
            onChange={onTabChange}
            items={navItems}
            ariaLabel={t("registry.registryLayout.navigation")}
          />
        </div>
      </Main.Topbar.Center.Portal>
      <Main.Toolbar.Portal visibility="compact">
        <RegistryTabs
          activeTab={visibleTab}
          onChange={onTabChange}
          items={navItems}
          ariaLabel={t("registry.registryLayout.navigation")}
        />
      </Main.Toolbar.Portal>

      <main className="flex-1 min-w-0 overflow-hidden">
        {visibleTab === "items" && <RegistryItemsPage />}
        {visibleTab === "requests" && acceptPublishRequests && (
          <RegistryRequestsPage />
        )}
        {visibleTab === "qa" && <RegistryMonitorPage />}
        {visibleTab === "settings" && (
          <RegistrySettingsPage
            revealedKey={revealedKey}
            onRevealedKeyChange={setRevealedKey}
          />
        )}
      </main>
    </div>
  );
}
