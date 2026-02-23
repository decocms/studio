import { useState, type ComponentType } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { CheckCircle, Container, Settings01, Tool02 } from "@untitledui/icons";
import { PLUGIN_ID } from "../../shared";
import { useBrokenMonitorsCount } from "../hooks/use-monitor";
import {
  usePublishRequestCount,
  useRegistryConfig,
} from "../hooks/use-registry";
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

function HeaderTabs({
  activeTab,
  onChange,
  items,
}: {
  activeTab: NavItem["tab"];
  onChange: (tab: NavItem["tab"]) => void;
  items: NavItem[];
}) {
  return (
    <nav className="flex items-center gap-2 overflow-x-auto no-scrollbar">
      {items.map((item) => {
        const active = activeTab === item.tab;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            className={cn(
              "h-7 px-2 text-sm rounded-lg border border-input transition-colors inline-flex gap-1.5 items-center whitespace-nowrap",
              active
                ? "bg-accent border-border text-foreground"
                : "bg-transparent text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground",
            )}
            onClick={() => onChange(item.tab)}
          >
            <Icon size={14} />
            <span>{item.label}</span>
            {typeof item.count === "number" && item.count > 0 && (
              <span className="min-w-4 h-4 px-1 inline-flex items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold">
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

export default function RegistryLayout() {
  const [activeTab, setActiveTab] = useState<NavItem["tab"]>("items");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const {
    registryName,
    registryIcon,
    registryLLMConnectionId,
    registryLLMModelId,
    acceptPublishRequests,
    requireApiToken,
    storePrivateOnly,
  } = useRegistryConfig(PLUGIN_ID);
  const pendingQuery = usePublishRequestCount();
  const brokenMonitors = useBrokenMonitorsCount();

  // Build a stable key from server config so SettingsPage re-mounts when
  // the persisted values change (e.g. after save).
  const settingsKey = `${registryName}|${registryIcon}|${registryLLMConnectionId}|${registryLLMModelId}|${acceptPublishRequests}|${requireApiToken}|${storePrivateOnly}`;

  // If publish requests were disabled while viewing requests tab, redirect
  if (!acceptPublishRequests && activeTab === "requests") {
    setActiveTab("items");
  }

  const pendingCount = pendingQuery.data?.pending ?? 0;
  const navItems: NavItem[] = [
    {
      id: "items",
      label: "Items",
      icon: Container,
      tab: "items",
      count:
        brokenMonitors.brokenCount > 0 ? brokenMonitors.brokenCount : undefined,
    },
    ...(acceptPublishRequests
      ? [
          {
            id: "requests",
            label: "Requests",
            icon: CheckCircle,
            tab: "requests" as const,
            count: pendingCount,
          },
        ]
      : []),
    { id: "qa", label: "QA", icon: Tool02, tab: "qa" },
    { id: "settings", label: "Settings", icon: Settings01, tab: "settings" },
  ];

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      <header className="shrink-0 w-full border-b border-border h-12 overflow-x-auto flex items-center justify-between gap-3 px-4 min-w-max">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            className="min-w-0 flex items-center gap-2 hover:opacity-90 transition-opacity cursor-pointer"
            onClick={() => setActiveTab("settings")}
          >
            <div className="size-7 rounded-lg border border-border overflow-hidden bg-muted/20 flex items-center justify-center shrink-0">
              {registryIcon ? (
                <img
                  src={registryIcon}
                  alt={registryName}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-[10px] font-semibold text-muted-foreground">
                  {registryName.slice(0, 1).toUpperCase()}
                </span>
              )}
            </div>
            <span className="text-sm font-medium truncate max-w-[220px]">
              {registryName}
            </span>
          </button>
          <div className="h-6 w-px bg-border shrink-0" />
          <HeaderTabs
            activeTab={activeTab}
            onChange={setActiveTab}
            items={navItems}
          />
        </div>
      </header>

      <main className="flex-1 min-w-0 overflow-hidden">
        {activeTab === "items" && <RegistryItemsPage />}
        {activeTab === "requests" && acceptPublishRequests && (
          <RegistryRequestsPage />
        )}
        {activeTab === "qa" && <RegistryMonitorPage />}
        {activeTab === "settings" && (
          <RegistrySettingsPage
            key={settingsKey}
            initialName={registryName}
            initialIcon={registryIcon}
            initialLLMConnectionId={registryLLMConnectionId}
            initialLLMModelId={registryLLMModelId}
            initialAcceptPublishRequests={acceptPublishRequests}
            initialRequireApiToken={requireApiToken}
            initialStorePrivateOnly={storePrivateOnly}
            revealedKey={revealedKey}
            onRevealedKeyChange={setRevealedKey}
          />
        )}
      </main>
    </div>
  );
}
