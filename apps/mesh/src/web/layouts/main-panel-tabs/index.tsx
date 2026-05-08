/**
 * MainPanelContent — renders the active main-panel tab's body.
 *
 * The tab bar itself lives in the agent-shell header; see
 * `main-panel-tabs-bar.tsx`. Both components consume the same state
 * via `useMainPanelTabs`.
 *
 * Tab sources and grammar are documented in `tab-id.ts`.
 */

import { Suspense, lazy } from "react";
import { Loading01 } from "@untitledui/icons";
import { useMainPanelTabs } from "./use-main-panel-tabs";
import { SettingsTab } from "./settings-tab";
import { GitTab } from "@/web/components/thread/github/git-tab";
import { PreviewTab } from "./preview-tab";
import { EnvTab } from "./env-tab";
import { AutomationTab } from "./automation-tab";
import { AutomationsListTab } from "./automations-list-tab";
import { isLegacySettingsTab, parsePinnedViewTabId } from "./tab-id";

const AppViewContent = lazy(() =>
  import("@/web/routes/project-app-view").then((m) => ({
    default: m.AppViewContent,
  })),
);

export function MainPanelContent({
  taskId,
  virtualMcpId,
}: {
  taskId: string;
  virtualMcpId: string;
}) {
  const { activeTab, layoutTabs, expandedTools, automationTabParsed } =
    useMainPanelTabs({
      virtualMcpId,
      taskId,
    });

  if (isLegacySettingsTab(activeTab)) {
    return <SettingsTab virtualMcpId={virtualMcpId} />;
  }
  if (activeTab === "git") {
    return <GitTab virtualMcpId={virtualMcpId} />;
  }
  if (activeTab === "automations") {
    return <AutomationsListTab virtualMcpId={virtualMcpId} />;
  }
  if (activeTab === "env") {
    return <EnvTab virtualMcpId={virtualMcpId} />;
  }
  if (activeTab === "preview") {
    return <PreviewTab virtualMcpId={virtualMcpId} />;
  }
  if (automationTabParsed) {
    return <AutomationTab tabId={activeTab} />;
  }

  const pinnedView = parsePinnedViewTabId(activeTab);
  if (pinnedView) {
    const expandedTool = expandedTools.find(
      (t) =>
        t.appId === pinnedView.connectionId &&
        t.toolName === pinnedView.toolName,
    );
    return (
      <Suspense
        fallback={
          <div className="h-full w-full flex items-center justify-center">
            <Loading01
              size={20}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <AppViewContent
          key={activeTab}
          connectionId={pinnedView.connectionId}
          toolName={pinnedView.toolName}
          args={expandedTool?.args}
        />
      </Suspense>
    );
  }

  const agentTab = layoutTabs.find((t) => t.id === activeTab);
  if (agentTab) {
    return (
      <Suspense
        fallback={
          <div className="h-full w-full flex items-center justify-center">
            <Loading01
              size={20}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <AppViewContent
          key={activeTab}
          connectionId={agentTab.view.appId}
          toolName={agentTab.id}
          args={agentTab.view.args}
        />
      </Suspense>
    );
  }

  return <SettingsTab virtualMcpId={virtualMcpId} />;
}
