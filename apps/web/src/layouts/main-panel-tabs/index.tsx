/**
 * MainPanelContent — renders the active main-panel tab's body.
 *
 * The tab bar itself lives in the agent-shell header; see
 * `main-panel-tabs-bar.tsx`. Both components consume the same state
 * via `useMainPanelTabs`.
 *
 * Tab sources and grammar are documented in `tab-id.ts`.
 */

import { lazy } from "react";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";
import { useMainPanelTabs } from "./use-main-panel-tabs";
import { SettingsTab } from "./settings-tab";
import { OrgAgentsTab } from "./org-agents-tab";
import { OverviewTab } from "./overview-tab";
import { TaskBoardPage } from "@/layouts/task-board";
import { GitTab } from "@/components/thread/github/git-tab";
import { PreviewTab } from "./preview-tab";
import { CodeTab } from "./code-tab";
import { ContentTab } from "./content-tab";
import { AssetsTab } from "./assets-tab";
import { AutomationTab } from "./automation-tab";
import { AutomationsListTab } from "./automations-list-tab";
import { FileTab } from "./file-tab";
import { ConnectSourcesTab } from "./connect-sources-tab";
import { ReportsTab } from "./reports-tab";
import { DiscoverTab } from "./discover-tab";
import { DeckTab } from "./deck-tab";
import { LibraryFileTab } from "./library-file-tab";
import { LibraryTab } from "./library-tab";
import {
  isLegacySettingsTab,
  parseCodeTabId,
  parseDeckTabId,
  parseFileTabId,
  parseLibraryFileTabId,
  parsePinnedViewTabId,
} from "./tab-id";
import { ErrorBoundary } from "@/components/error-boundary";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { usePublicConfig } from "@/hooks/use-public-config";
import { useScopeId } from "@/hooks/use-project-scope";

const AppViewContent = lazy(() =>
  import("@/routes/project-app-view").then((m) => ({
    default: m.AppViewContent,
  })),
);

// The control-plane / Monitor tabs are product-gated and heavy (charts, maps,
// locale data), so lazy-load them: users without access never download them.
// TabBody renders inside MainPanelContent's Suspense boundary.
const HostingTab = lazy(() =>
  import("./hosting-tab").then((m) => ({ default: m.HostingTab })),
);
const E2eTab = lazy(() =>
  import("./e2e-tab").then((m) => ({ default: m.E2eTab })),
);
const AnalyticsTab = lazy(() =>
  import("./analytics-tab").then((m) => ({ default: m.AnalyticsTab })),
);
const CdnTab = lazy(() =>
  import("./cdn-tab").then((m) => ({ default: m.CdnTab })),
);
/**
 * `/$org/home` is two pages behind one view id: the ORG's home when nothing is
 * scoped, and the scoped AGENT's home when something is. That duality is the
 * route's — `/home` has always served both, and `staticData.defaultMain` names
 * one view for both — so it is answered here rather than invented as a second
 * tab id the URL would then have to carry. `useScopeId` reads the scope
 * straight off the search and subscribes to no query, so it cannot suspend.
 */
function HomeTab() {
  const scopeId = useScopeId();
  return scopeId ? <OverviewTab /> : <OrgAgentsTab />;
}

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
  taskId: string | null;
  layoutTabs: ReturnType<typeof useMainPanelTabs>["layoutTabs"];
  expandedTools: ReturnType<typeof useMainPanelTabs>["expandedTools"];
  automationTabParsed: ReturnType<
    typeof useMainPanelTabs
  >["automationTabParsed"];
}) {
  const controlPlaneViews = useControlPlaneViews();
  // Native CDN Monitor tab gate — warehouse wired, independent of the
  // control-plane. Ownership is enforced by the BFF; combined with
  // `controlPlaneViews.monitor` below this guards the deep-link `?main=cdn`
  // against a deployment with no warehouse AND against a client the org's
  // `monitor_enabled` flag hasn't opted in.
  const monitorEnabled =
    usePublicConfig().monitorEnabled === true ||
    usePublicConfig().auth.localMode === true;

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
    return <HomeTab />;
  }
  if (activeTab === "board") {
    // Task board opened next to chat, as the Tasks destination's own view.
    // The main panel already supplies the card chrome, so the page only needs
    // a full-height flex column around it.
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
  if (activeTab === "site-editor") {
    return <PreviewTab virtualMcpId={virtualMcpId} />;
  }
  const codeTab = parseCodeTabId(activeTab);
  if (codeTab) {
    return <CodeTab openPath={codeTab.path} />;
  }
  if (activeTab === "content") {
    return <ContentTab virtualMcpId={virtualMcpId} />;
  }
  if (activeTab === "assets") {
    return <AssetsTab virtualMcpId={virtualMcpId} />;
  }
  // Control-plane tabs are behind the same per-view product gate as their tab
  // buttons (see useControlPlaneViews) so a deep-link `?main=hosting` can't
  // bypass it while the surface rolls out. Access to the data itself is enforced
  // by the BFF.
  if (activeTab === "hosting" && controlPlaneViews.hosting) {
    return <HostingTab virtualMcpId={virtualMcpId} />;
  }
  if (activeTab === "e2e" && controlPlaneViews.e2e) {
    return <E2eTab virtualMcpId={virtualMcpId} />;
  }
  if (activeTab === "analytics" && controlPlaneViews.analytics) {
    return <AnalyticsTab virtualMcpId={virtualMcpId} />;
  }
  if (activeTab === "cdn" && monitorEnabled && controlPlaneViews.monitor) {
    return <CdnTab virtualMcpId={virtualMcpId} />;
  }
  if (activeTab === "files") {
    return <LibraryTab />;
  }
  if (activeTab === "reports") {
    // The Reports destination for an org with no report yet: start a diagnostic.
    return <ReportsTab />;
  }
  if (activeTab === "discover") {
    // What this org doesn't have yet: setup, capabilities off, the catalog.
    return <DiscoverTab />;
  }
  if (activeTab === "connect-sources") {
    // Report app hand-off (the `connect-sources` view) for a client who skipped
    // a data source during onboarding — see project-app-navigate.ts.
    return <ConnectSourcesTab />;
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
      <LibraryFileTab key={libraryFileTab.path} path={libraryFileTab.path} />
    );
  }

  const pinnedView = parsePinnedViewTabId(activeTab);
  if (pinnedView) {
    const expandedTool = expandedTools.find(
      (t) =>
        t.appId === pinnedView.connectionId &&
        t.toolName === pinnedView.toolName,
    );
    return (
      <MainPanelBoundary>
        <AppViewContent
          key={activeTab}
          connectionId={pinnedView.connectionId}
          toolName={pinnedView.toolName}
          args={expandedTool?.args}
        />
      </MainPanelBoundary>
    );
  }

  const agentTab = layoutTabs.find((t) => t.id === activeTab);
  if (agentTab) {
    return (
      <MainPanelBoundary>
        <AppViewContent
          key={activeTab}
          connectionId={agentTab.view.appId}
          toolName={agentTab.id}
          args={agentTab.view.args}
        />
      </MainPanelBoundary>
    );
  }

  return <SettingsTab virtualMcpId={virtualMcpId} />;
}

export function MainPanelContent({
  taskId,
  virtualMcpId,
}: {
  taskId: string | null;
  virtualMcpId: string;
}) {
  const { activeTab, layoutTabs, expandedTools, automationTabParsed } =
    useMainPanelTabs({
      virtualMcpId,
      taskId,
    });

  return (
    <ErrorBoundary key={activeTab}>
      <MainPanelBoundary>
        <TabBody
          activeTab={activeTab}
          virtualMcpId={virtualMcpId}
          taskId={taskId}
          layoutTabs={layoutTabs}
          expandedTools={expandedTools}
          automationTabParsed={automationTabParsed}
        />
      </MainPanelBoundary>
    </ErrorBoundary>
  );
}
