import { useState } from "react";
import { Badge } from "@deco/ui/components/badge.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { BrokenMCPList } from "./broken-mcp-list";
import { MonitorConfiguration } from "./monitor-configuration";
import { MonitorConnectionsPanel } from "./monitor-connections-panel";
import { MonitorDashboard } from "./monitor-dashboard";
import { MonitorRunDetail } from "./monitor-run-detail";
import { MonitorRunHistory } from "./monitor-run-history";
import { useMonitorResults, useMonitorRun } from "@/hooks/registry/use-monitor";

type MonitorSubTab = "tests" | "configuration" | "connections";

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
    <div className="h-full overflow-auto px-4 md:px-6 py-4 space-y-6">
      <nav className="flex items-center gap-2 overflow-x-auto no-scrollbar">
        {[
          {
            id: "tests" as const,
            labelKey: "registry.registryMonitorPage.tabTests" as const,
          },
          {
            id: "configuration" as const,
            labelKey: "registry.registryMonitorPage.tabConfiguration" as const,
          },
          {
            id: "connections" as const,
            labelKey: "registry.registryMonitorPage.tabConnections" as const,
          },
        ].map((item) => {
          const isActive = activeSubTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={cn(
                "h-7 px-2 text-sm rounded-lg border border-input transition-colors inline-flex gap-1.5 items-center whitespace-nowrap",
                isActive
                  ? "bg-accent border-border text-foreground"
                  : "bg-transparent text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground",
              )}
              onClick={() => setActiveSubTab(item.id)}
            >
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </nav>

      {activeSubTab === "tests" && (
        <div className="space-y-6">
          <MonitorDashboard
            activeRunId={activeRunId}
            onRunChange={setActiveRunId}
          />

          <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
            <div className="xl:col-span-8 space-y-6 min-w-0">
              {activeRunId && <MonitorRunDetail runId={activeRunId} />}
              <MonitorRunHistory
                selectedRunId={activeRunId}
                onSelectRun={setActiveRunId}
              />
            </div>
            <div className="xl:col-span-4 space-y-2 min-w-0">
              <h3 className="text-sm font-semibold">
                {t("registry.registryMonitorPage.brokenMcps")}{" "}
                {failedResults.length > 0 && (
                  <Badge variant="destructive" className="text-[10px] ml-1">
                    {failedResults.length}
                  </Badge>
                )}
              </h3>
              <BrokenMCPList results={failedResults} />
            </div>
          </div>
        </div>
      )}

      {activeSubTab === "configuration" && <MonitorConfiguration />}

      {activeSubTab === "connections" && <MonitorConnectionsPanel />}
    </div>
  );
}
