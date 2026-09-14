import { useState } from "react";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { CollectionTabs } from "@/components/collections/collection-tabs.tsx";
import { Main } from "@/components/main";
import { useMonitorResults, useMonitorRun } from "@/hooks/registry/use-monitor";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { BrokenMCPList } from "./broken-mcp-list";
import { MonitorConfiguration } from "./monitor-configuration";
import { MonitorConnectionsPanel } from "./monitor-connections-panel";
import { MonitorDashboard } from "./monitor-dashboard";
import { MonitorRunDetail } from "./monitor-run-detail";
import { MonitorRunHistory } from "./monitor-run-history";

type MonitorSubTab = "tests" | "configuration" | "connections";

const MONITOR_TABS = [
  {
    id: "tests",
    labelKey: "registry.registryMonitorPage.tabTests",
  },
  {
    id: "configuration",
    labelKey: "registry.registryMonitorPage.tabConfiguration",
  },
  {
    id: "connections",
    labelKey: "registry.registryMonitorPage.tabConnections",
  },
] as const satisfies ReadonlyArray<{
  id: MonitorSubTab;
  labelKey: TranslationKey;
}>;

function isMonitorSubTab(value: string): value is MonitorSubTab {
  return MONITOR_TABS.some((tab) => tab.id === value);
}

export default function RegistryMonitorPage() {
  const t = useT();
  const [activeRunId, setActiveRunId] = useState<string | undefined>(undefined);
  const [activeSubTab, setActiveSubTab] = useState<MonitorSubTab>("tests");
  const runQuery = useMonitorRun(activeRunId);
  const runStatus = runQuery.data?.run?.status;
  const resultsQuery = useMonitorResults(activeRunId, undefined, runStatus);
  const failedResults = (resultsQuery.data?.items ?? []).filter(
    (result) => result.status === "failed" || result.status === "error",
  );

  return (
    <>
      <Main.Toolbar.Portal>
        <CollectionTabs
          ariaLabel={t("registry.registryMonitorPage.navigation")}
          className="w-full"
          activeTab={activeSubTab}
          onTabChange={(nextTab) => {
            if (isMonitorSubTab(nextTab)) setActiveSubTab(nextTab);
          }}
          tabs={MONITOR_TABS.map((tab) => ({
            id: tab.id,
            label: t(tab.labelKey),
          }))}
        />
      </Main.Toolbar.Portal>

      <div className="h-full overflow-auto">
        <Main.Container width="wide" padding="compact">
          <Main.Stack>
            {activeSubTab === "tests" && (
              <Main.Stack>
                <MonitorDashboard
                  activeRunId={activeRunId}
                  onRunChange={setActiveRunId}
                />

                <div className="grid grid-cols-1 items-start gap-4 @5xl:grid-cols-12">
                  <div className="min-w-0 space-y-6 @5xl:col-span-8">
                    {activeRunId && <MonitorRunDetail runId={activeRunId} />}
                    <MonitorRunHistory
                      selectedRunId={activeRunId}
                      onSelectRun={setActiveRunId}
                    />
                  </div>
                  <Main.Section className="min-w-0 gap-2 @5xl:col-span-4">
                    <Main.Section.Header>
                      <Main.Section.Title>
                        {t("registry.registryMonitorPage.brokenMcps")}
                      </Main.Section.Title>
                      {failedResults.length > 0 && (
                        <Badge variant="destructive" className="text-[10px]">
                          {failedResults.length}
                        </Badge>
                      )}
                    </Main.Section.Header>
                    <BrokenMCPList results={failedResults} />
                  </Main.Section>
                </div>
              </Main.Stack>
            )}

            {activeSubTab === "configuration" && <MonitorConfiguration />}

            {activeSubTab === "connections" && <MonitorConnectionsPanel />}
          </Main.Stack>
        </Main.Container>
      </div>
    </>
  );
}
