import { parseAutomationTabId } from "./tab-id";
import { SettingsTab as AutomationInlineDetail } from "@/views/automations/automation-detail";
import { AutomationRunsView } from "@/views/automations/automation-runs";
import { useAutomation } from "@/hooks/use-automations";
import { Page } from "@/components/page";
import { Button } from "@decocms/ui/components/button.tsx";
import { CollectionTabs } from "@/components/collections/collection-tabs.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { ArrowLeft } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { MainPanelLoading } from "./main-panel-loading";
import { useT } from "@/i18n/use-t.ts";

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
}: {
  automationId: string;
  triggerIds: string[];
}) {
  const t = useT();
  const [windowKey, setWindowKey] = useState<WindowKey>("30d");
  const [range, setRange] = useState(() => computeRange("30d"));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-end">
        <Select
          value={windowKey}
          onValueChange={(v) => {
            const key = v as WindowKey;
            setWindowKey(key);
            setRange(computeRange(key));
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOW_OPTIONS.map((o) => (
              <SelectItem key={o.key} value={o.key}>
                {t(o.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <AutomationRunsView
        automationId={automationId}
        triggerIds={triggerIds}
        range={range}
      />
    </div>
  );
}

export function AutomationTab({ tabId }: { tabId: string }) {
  const parsed = parseAutomationTabId(tabId);
  if (!parsed) return null;

  return (
    <Suspense fallback={<MainPanelLoading />}>
      <AutomationTabInner id={parsed.id} />
    </Suspense>
  );
}

function AutomationTabInner({ id }: { id: string }) {
  const t = useT();
  const navigate = useNavigate();
  const { data: automation, isLoading } = useAutomation(id);
  const [tab, setTab] = useState<"settings" | "runs">("settings");

  const onBack = () => {
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        main: "automations",
      }),
      replace: true,
    });
  };

  if (isLoading) {
    return <MainPanelLoading />;
  }

  if (!automation) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
        {t("mainPanelTabs.automationTab.automationNotFound")}
      </div>
    );
  }

  const triggerIds = automation.triggers.map((t) => t.id);

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex items-center justify-between pb-4 shrink-0">
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeft size={14} />
              {t("mainPanelTabs.automationTab.backToList")}
            </Button>
            <CollectionTabs
              tabs={[
                {
                  id: "settings",
                  label: t("mainPanelTabs.automationTab.settings"),
                },
                { id: "runs", label: t("mainPanelTabs.automationTab.runs") },
              ]}
              activeTab={tab}
              onTabChange={(t) => setTab(t as "settings" | "runs")}
            />
          </div>

          {tab === "settings" ? (
            <AutomationInlineDetail automationId={id} automation={automation} />
          ) : (
            <RunsTab automationId={id} triggerIds={triggerIds} />
          )}
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
