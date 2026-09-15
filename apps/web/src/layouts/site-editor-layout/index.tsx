import { Outlet } from "@tanstack/react-router";
import { Main } from "@/components/main";
import { RouteMainTitle } from "@/layouts/route-main-title";
import { useChatTask } from "@/components/chat/context";
import { ChatModeRow } from "@/components/chat/pills/chat-mode-row";
import { ErrorBoundary } from "@/components/error-boundary";
import { CmsHeaderActions } from "@/components/thread/github/cms-header-actions";
import { HeaderActions } from "@/components/thread/github/header-actions";
import { DevAgentControl } from "@/components/dev-agent/dev-agent-control";
import { useRouteMainTitle } from "@/hooks/use-route-main-title";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import {
  agentHasClonableSource,
  agentShowsGithubHeaderActions,
} from "@/lib/agent-capabilities";
import { MainPanelBoundary } from "@/layouts/main-panel-boundary";
import { MainPanelTestErrorTrigger } from "@/layouts/main-panel-test-error-trigger";
import { MainPanelTabsBar } from "@/layouts/main-panel-tabs/main-panel-tabs-bar";
import { PreviewDrawerHost } from "@/layouts/main-panel-tabs/preview-drawer-host";
import { WorkspaceMainLeading } from "@/layouts/agent-shell-layout/workspace-main-controls";
import { useWorkspace } from "@/layouts/agent-shell-layout/workspace-context";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { shouldShowSiteEditorDrawer } from "./drawer-availability";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { useT } from "@/i18n/use-t";
import {
  CodeWorkspaceProvider,
  codeWorkspaceIdentityKey,
  useCodeWorkspace,
} from "@/components/sandbox/preview/file-explorer/code-workspace-context";
import { CodeWorkspaceNavigationGuard } from "@/components/sandbox/preview/file-explorer/code-workspace-navigation-guard";

export interface SiteEditorLayoutProps {
  agentId: string;
}

function SiteEditorChatModeRow({
  entity,
  currentBranch,
}: {
  entity: Parameters<typeof ChatModeRow>[0]["virtualMcp"];
  currentBranch: string | null;
}) {
  const { requestIdentityChange } = useCodeWorkspace();
  return (
    <ChatModeRow
      virtualMcp={entity}
      currentBranch={currentBranch}
      requestBranchChange={requestIdentityChange}
    />
  );
}

/**
 * Route-owned composition for Preview, Content, and Code.
 *
 * Runtime and source checks decide only whether a console can exist. The
 * nested route decides which editor body renders, so Code inherits the same
 * console without adding its name to an allowlist.
 */
export function SiteEditorLayout({ agentId }: SiteEditorLayoutProps) {
  const t = useT();
  const workspace = useWorkspace();
  const { org } = useProjectContext();
  const title = useRouteMainTitle() ?? t("sidebar.projectNav.siteEditor");
  const entity = useVirtualMCP(agentId);
  const { activeTask, currentBranch, taskId } = useChatTask();
  const session = useSessionRuntime(agentId);
  const routeView = useActivePanelTabId() ?? "site-editor";
  const hasClonableSource =
    agentHasClonableSource(entity?.metadata) ||
    agentHasClonableSource(activeTask?.metadata);
  const showDrawer = shouldShowSiteEditorDrawer({
    hasClonableSource,
    runtime: session.runtime,
  });
  const codeWorkspaceIdentity = {
    orgSlug: org.slug,
    virtualMcpId: agentId,
    branch: currentBranch,
    threadId: taskId ?? null,
  };

  return (
    <CodeWorkspaceProvider identity={codeWorkspaceIdentity}>
      <Main>
        <CodeWorkspaceNavigationGuard />
        <Main.Topbar className="flex h-auto min-h-12 flex-wrap gap-y-1 py-1">
          <Main.Topbar.Left className="flex-1 basis-auto">
            <WorkspaceMainLeading currentRouteTitle={title} />
            <RouteMainTitle title={title} compact className="flex-initial" />
            <div className="hidden min-w-0 md:flex">
              <MainPanelTabsBar
                disableActiveMainToggle={!workspace.sidePanelOpen}
              />
            </div>
            <Main.Topbar.Left.Target />
          </Main.Topbar.Left>

          <Main.Topbar.Center className="hidden flex-1 basis-40 md:flex">
            <Main.Topbar.Center.Target />
          </Main.Topbar.Center>

          <Main.Topbar.Right className="ml-auto shrink-0">
            <Main.Topbar.Right.Target />
            <div className="hidden min-w-0 shrink items-center justify-end md:flex">
              <SiteEditorChatModeRow
                entity={entity}
                currentBranch={currentBranch}
              />
            </div>
            <div className="flex shrink-0 items-center justify-end gap-1">
              {entity && (
                <>
                  <div className="hidden md:block">
                    <DevAgentControl virtualMcp={entity} />
                  </div>
                  {agentShowsGithubHeaderActions(entity) &&
                    (session.runtime === "cms" ? (
                      <CmsHeaderActions virtualMcpId={entity.id} />
                    ) : (
                      <HeaderActions virtualMcpId={entity.id} />
                    ))}
                </>
              )}
            </div>
          </Main.Topbar.Right>
        </Main.Topbar>

        {/* The drawer measures this body region, not the whole Main card. Route
          chrome can therefore grow without stealing the preview reserve at
          the drawer's maximum height. */}
        <div
          key={codeWorkspaceIdentityKey(codeWorkspaceIdentity)}
          data-slot="site-editor-workspace"
          className="flex min-h-0 flex-1 flex-col"
        >
          <Main.Content mode="canvas">
            <ErrorBoundary resetKey={routeView}>
              <MainPanelBoundary>
                <MainPanelTestErrorTrigger routeId={routeView}>
                  <Outlet />
                </MainPanelTestErrorTrigger>
              </MainPanelBoundary>
            </ErrorBoundary>
          </Main.Content>

          {showDrawer && (
            <Main.Drawer>
              <PreviewDrawerHost virtualMcpId={agentId} />
            </Main.Drawer>
          )}
        </div>
      </Main>
    </CodeWorkspaceProvider>
  );
}
