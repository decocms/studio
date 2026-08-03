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
import { useMainPanelTabs } from "./use-main-panel-tabs";
import { SettingsTab } from "./settings-tab";
import { OverviewTab } from "./overview-tab";
import { TaskBoardPage } from "@/layouts/task-board";
import { GitTab } from "@/components/thread/github/git-tab";
import { PreviewTab } from "./preview-tab";
import { CodeTab } from "./code-tab";
import { ContentTab } from "./content-tab";
import { AutomationTab } from "./automation-tab";
import { AutomationsListTab } from "./automations-list-tab";
import { FileTab } from "./file-tab";
import { DeckTab } from "./deck-tab";
import { LibraryFileTab } from "./library-file-tab";
import { LibraryTab } from "./library-tab";
import { MainPanelLoading } from "./main-panel-loading";
import {
  isLegacySettingsTab,
  parseCodeTabId,
  parseDeckTabId,
  parseFileTabId,
  parseLibraryFileTabId,
  parsePinnedViewTabId,
} from "./tab-id";
import { ErrorBoundary } from "@/components/error-boundary";
import { useChatTask } from "@/components/chat/context";

const AppViewContent = lazy(() =>
  import("@/routes/project-app-view").then((m) => ({
    default: m.AppViewContent,
  })),
);

function TabBody({
  activeTab,
  virtualMcpId,
  taskId,
  layoutTabs,
  expandedTools,
  automationTabParsed,
}: {
  activeTab: string;
  virtualMcpId: string;
  taskId: string;
  layoutTabs: ReturnType<typeof useMainPanelTabs>["layoutTabs"];
  expandedTools: ReturnType<typeof useMainPanelTabs>["expandedTools"];
  automationTabParsed: ReturnType<
    typeof useMainPanelTabs
  >["automationTabParsed"];
}) {
  const { canMutateThread } = useChatTask();

  // Test hook: e2e tests set window.__forceTabError = <activeTab> to deliberately
  // crash the active tab and exercise the ErrorBoundary recovery flow.
  // Dead-stripped from real production builds; alive in dev and in the e2e
  // build (which serves the prod bundle via vite preview — see
  // packages/e2e/playwright.config.ts) through the E2E_TEST_HOOKS define.
  if (
    (import.meta.env.DEV || __E2E_TEST_HOOKS__) &&
    typeof window !== "undefined" &&
    (window as unknown as { __forceTabError?: string }).__forceTabError ===
      activeTab
  ) {
    throw new Error(`forced tab error: ${activeTab}`);
  }

  if (activeTab === "overview") {
    return <OverviewTab />;
  }
  if (activeTab === "board") {
    // Task board opened next to chat via the Tasks toggle (`?main=board`).
    // The main panel already supplies the card chrome, so render the inner
    // page inside a full-height flex column (mirrors the standalone route).
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <TaskBoardPage />
      </div>
    );
  }
  if (isLegacySettingsTab(activeTab)) {
    return <SettingsTab virtualMcpId={virtualMcpId} />;
  }
  if (activeTab === "git") {
    return <GitTab virtualMcpId={virtualMcpId} />;
  }
  if (activeTab === "automations") {
    return <AutomationsListTab virtualMcpId={virtualMcpId} />;
  }
  if (activeTab === "preview") {
    return <PreviewTab virtualMcpId={virtualMcpId} />;
  }
  const codeTab = parseCodeTabId(activeTab);
  if (codeTab) {
    if (!canMutateThread) {
      return <PreviewTab virtualMcpId={virtualMcpId} />;
    }
    return <CodeTab openPath={codeTab.path} />;
  }
  if (activeTab === "content") {
    if (!canMutateThread) {
      return <PreviewTab virtualMcpId={virtualMcpId} />;
    }
    return <ContentTab virtualMcpId={virtualMcpId} />;
  }
  if (activeTab === "files") {
    return <LibraryTab />;
  }
  if (automationTabParsed) {
    return <AutomationTab tabId={activeTab} />;
  }

  const deckTab = parseDeckTabId(activeTab);
  if (deckTab) {
    return <DeckTab key={deckTab.path} path={deckTab.path} />;
  }

  const fileTab = parseFileTabId(activeTab);
  if (fileTab) {
    return <FileTab fileKey={fileTab.key} taskId={taskId} />;
  }

  const libraryFileTab = parseLibraryFileTabId(activeTab);
  if (libraryFileTab) {
    return (
      <LibraryFileTab
        key={libraryFileTab.path}
        path={libraryFileTab.path}
        readOnly={!canMutateThread}
      />
    );
  }

  const pinnedView = parsePinnedViewTabId(activeTab);
  if (pinnedView) {
    if (!canMutateThread) {
      return <PreviewTab virtualMcpId={virtualMcpId} />;
    }
    const expandedTool = expandedTools.find(
      (t) =>
        t.appId === pinnedView.connectionId &&
        t.toolName === pinnedView.toolName,
    );
    return (
      <Suspense fallback={<MainPanelLoading />}>
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
    if (!canMutateThread) {
      return <PreviewTab virtualMcpId={virtualMcpId} />;
    }
    return (
      <Suspense fallback={<MainPanelLoading />}>
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

  return (
    <ErrorBoundary key={activeTab}>
      <Suspense fallback={<MainPanelLoading />}>
        <TabBody
          activeTab={activeTab}
          virtualMcpId={virtualMcpId}
          taskId={taskId}
          layoutTabs={layoutTabs}
          expandedTools={expandedTools}
          automationTabParsed={automationTabParsed}
        />
      </Suspense>
    </ErrorBoundary>
  );
}
