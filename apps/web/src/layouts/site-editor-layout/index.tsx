import { Outlet } from "@tanstack/react-router";
import { Main } from "@/components/main";
import { MainBreadcrumb } from "@/components/main-breadcrumb";
import {
  agentMainBreadcrumbItem,
  organizationMainBreadcrumbItem,
} from "@/components/main-breadcrumb/route-items";
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
import {
  WorkspaceMainLeading,
  WorkspaceMainTrailing,
} from "@/layouts/agent-shell-layout/workspace-main-controls";
import { useWorkspace } from "@/layouts/agent-shell-layout/workspace-context";
import {
  getDecopilotId,
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
} from "@/sdk";
import { shouldShowSiteEditorDrawer } from "./drawer-availability";
import {
  useActivePanelTabId,
  useMatchedMainView,
} from "@/layouts/main-panel-tabs/use-panel-navigate";
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
  const breadcrumbAgent =
    entity ??
    (agentId === getDecopilotId(org.id)
      ? getWellKnownDecopilotVirtualMCP(org.id)
      : {
          id: agentId,
          title: t("taskBoard.taskDialog.projectLabel"),
          icon: null,
        });
  const { activeTask, currentBranch, taskId } = useChatTask();
  const session = useSessionRuntime(agentId);
  const routeView = useActivePanelTabId() ?? "site-editor";
  const siteEditorView = useMatchedMainView().siteEditorView ?? "preview";
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
        <Main.Topbar className="grid-cols-[minmax(0,1fr)_auto]">
          <Main.Topbar.Left>
            <WorkspaceMainLeading currentRouteTitle={title} />
            <MainBreadcrumb
              compactTitle="visually-hidden"
              scope={organizationMainBreadcrumbItem(
                org,
                t("sidebar.navDestinations.home"),
              )}
              ancestors={[
                agentMainBreadcrumbItem(
                  org.slug,
                  breadcrumbAgent,
                  t("taskBoard.taskDialog.projectLabel"),
                ),
              ]}
              current={{ id: "site-editor", label: title }}
            />
            <Main.Topbar.Left.Target />
          </Main.Topbar.Left>

          <Main.Topbar.Center className="hidden" />

          <Main.Topbar.Right className="col-start-2">
            <div className="hidden min-w-0 shrink items-center justify-end md:flex">
              <SiteEditorChatModeRow
                entity={entity}
                currentBranch={currentBranch}
              />
            </div>
            {/* Route-local actions belong between the branch selector and this
              non-shrinking cluster in both visual and keyboard order. */}
            <Main.Topbar.Right.Target />
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
              <WorkspaceMainTrailing />
            </div>
          </Main.Topbar.Right>
        </Main.Topbar>

        {/* Site Editor has its own compact mode toolbar. Keeping mode and page
          controls off the route/publishing row gives CMS actions a stable,
          unclipped home even when Chat leaves Main near its minimum width. */}
        <Main.Toolbar className="@container [container-name:main-topbar_panel-header] hidden h-10 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-1.5 py-0 md:grid">
          <Main.Toolbar.Left className="overflow-hidden">
            <MainPanelTabsBar
              disableActiveMainToggle={!workspace.sidePanelOpen}
            />
            <Main.Toolbar.Left.Target />
          </Main.Toolbar.Left>
          {/* Preview contributes stateful URL controls through the center;
            mode-specific tools can use the stable right-hand target. */}
          <Main.Toolbar.Center>
            <Main.Toolbar.Center.Target />
          </Main.Toolbar.Center>
          <Main.Toolbar.Right>
            <Main.Toolbar.Right.Target />
          </Main.Toolbar.Right>
        </Main.Toolbar>

        {/* The drawer measures this body region, not the whole Main card. Route
          chrome can therefore grow without stealing the preview reserve at
          the drawer's maximum height. */}
        <div
          key={codeWorkspaceIdentityKey(codeWorkspaceIdentity)}
          data-slot="site-editor-workspace"
          className="flex min-h-0 flex-1 flex-col"
        >
          <Main.Content mode="canvas">
            <ErrorBoundary key={siteEditorView}>
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
