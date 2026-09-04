import { parseAutomationTabId } from "./tab-id";
import { SettingsTab as AutomationInlineDetail } from "@/views/automations/automation-detail";
import { AutomationRunsView } from "@/views/automations/automation-runs";
import { useAutomation } from "@/hooks/use-automations";
import { CollectionTabs } from "@/components/collections/collection-tabs.tsx";
import { Main } from "@/components/main";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Suspense, useState } from "react";
import { PanelLoading } from "@/layouts/main-panel-boundary";
import { useT } from "@/i18n/use-t.ts";
import { automationMatchesRouteAgent } from "./automation-route";

// Stat-card window options for the Runs tab. Anchored once at selection time so
// the derived ISO range is stable across renders (avoids refetch loops).
const WINDOW_OPTIONS = [
  {
    key: "24h",
    labelKey: "mainPanelTabs.automationTab.last24hours",
    ms: 24 * 60 * 60 * 1000,
  },
  {
    key: "7d",
    labelKey: "mainPanelTabs.automationTab.last7days",
    ms: 7 * 24 * 60 * 60 * 1000,
  },
  {
    key: "30d",
    labelKey: "mainPanelTabs.automationTab.last30days",
    ms: 30 * 24 * 60 * 60 * 1000,
  },
] as const;

type WindowKey = (typeof WINDOW_OPTIONS)[number]["key"];

function isWindowKey(value: string): value is WindowKey {
  return WINDOW_OPTIONS.some((option) => option.key === value);
}

function computeRange(key: WindowKey): { startDate: string; endDate: string } {
  const ms = WINDOW_OPTIONS.find((o) => o.key === key)!.ms;
  const now = Date.now();
  return {
    startDate: new Date(now - ms).toISOString(),
    endDate: new Date(now).toISOString(),
  };
}

function RunsTab({
  automationId,
  triggerIds,
  range,
}: {
  automationId: string;
  triggerIds: string[];
  range: { startDate: string; endDate: string };
}) {
  return (
    <AutomationRunsView
      automationId={automationId}
      triggerIds={triggerIds}
      range={range}
    />
  );
}

export function AutomationTab({
  tabId,
  routeAgentId,
  activeView,
  onViewChange,
}: {
  tabId: string;
  routeAgentId: string;
  activeView: "settings" | "runs";
  onViewChange: (view: "settings" | "runs") => void;
}) {
  const parsed = parseAutomationTabId(tabId);
  if (!parsed) return null;

  return (
    <Suspense fallback={<PanelLoading />}>
      <AutomationTabInner
        id={parsed.id}
        routeAgentId={routeAgentId}
        activeView={activeView}
        onViewChange={onViewChange}
      />
    </Suspense>
  );
}

function AutomationTabInner({
  id,
  routeAgentId,
  activeView,
  onViewChange,
}: {
  id: string;
  routeAgentId: string;
  activeView: "settings" | "runs";
  onViewChange: (view: "settings" | "runs") => void;
}) {
  const t = useT();
  const { data: automation, isLoading } = useAutomation(id);
  const [windowKey, setWindowKey] = useState<WindowKey>("30d");
  const [range, setRange] = useState(() => computeRange("30d"));

  if (isLoading) {
    return <PanelLoading />;
  }

  if (
    !automation ||
    !automationMatchesRouteAgent(automation.virtual_mcp_id, routeAgentId)
  ) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
        {t("mainPanelTabs.automationTab.automationNotFound")}
      </div>
    );
  }

  const triggerIds = automation.triggers.map((t) => t.id);

  return (
    <>
      <Main.Toolbar.Portal>
        <div className="flex w-full min-w-0 items-center justify-between gap-3">
          <CollectionTabs
            ariaLabel={t("sidebar.projectNav.automations")}
            tabs={[
              {
                id: "settings",
                label: t("mainPanelTabs.automationTab.settings"),
              },
              { id: "runs", label: t("mainPanelTabs.automationTab.runs") },
            ]}
            activeTab={activeView}
            onTabChange={(next) => {
              if (next === "settings" || next === "runs") {
                onViewChange(next);
              }
            }}
          />
          {activeView === "runs" ? (
            <Select
              value={windowKey}
              onValueChange={(value) => {
                if (!isWindowKey(value)) return;
                setWindowKey(value);
                setRange(computeRange(value));
              }}
            >
              <SelectTrigger className="h-8 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOW_OPTIONS.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </Main.Toolbar.Portal>

      <div className="h-full min-h-0 overflow-auto">
        <Main.Container width="standard">
          {activeView === "settings" ? (
            <AutomationInlineDetail automationId={id} automation={automation} />
          ) : (
            <RunsTab automationId={id} triggerIds={triggerIds} range={range} />
          )}
        </Main.Container>
      </div>
    </>
  );
}
