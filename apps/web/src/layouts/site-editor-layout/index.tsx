import { Outlet } from "@tanstack/react-router";
import { Main } from "@/components/main";
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
import { useVirtualMCP } from "@/sdk";
import { shouldShowSiteEditorDrawer } from "./drawer-availability";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";

export interface SiteEditorLayoutProps {
  agentId: string;
}

/**
 * Route-owned composition for Preview, Content, and Code.
 *
 * Runtime and source checks decide only whether a console can exist. The
 * nested route decides which editor body renders, so Code inherits the same
 * console without adding its name to an allowlist.
 */
export function SiteEditorLayout({ agentId }: SiteEditorLayoutProps) {
  const workspace = useWorkspace();
  const title = useRouteMainTitle();
  const entity = useVirtualMCP(agentId);
  const { activeTask, currentBranch } = useChatTask();
  const session = useSessionRuntime(agentId);
  const routeView = useActivePanelTabId() ?? "site-editor";
  const hasClonableSource =
    agentHasClonableSource(entity?.metadata) ||
    agentHasClonableSource(activeTask?.metadata);
  const showDrawer = shouldShowSiteEditorDrawer({
    hasClonableSource,
    runtime: session.runtime,
  });

  return (
    <Main>
      <Main.Topbar>
        <Main.Topbar.Left>
          <WorkspaceMainLeading currentRouteTitle={title} />
          {title ? <Main.Title className="sr-only">{title}</Main.Title> : null}
          <div className="hidden min-w-0 overflow-hidden md:block">
            <MainPanelTabsBar
              disableActiveMainToggle={!workspace.sidePanelOpen}
            />
          </div>
          <Main.Topbar.Left.Target />
        </Main.Topbar.Left>

        {/* Preview contributes its stateful URL controls through this stable
            target. Content and Code leave it empty. */}
        <Main.Topbar.Center className="hidden md:flex">
          <Main.Topbar.Center.Target />
        </Main.Topbar.Center>

        <Main.Topbar.Right>
          <div className="hidden min-w-0 shrink items-center justify-end md:flex">
            <ChatModeRow virtualMcp={entity} currentBranch={currentBranch} />
          </div>
          {/* Route-local actions belong between the branch selector and this
              non-shrinking cluster in both visual and keyboard order. */}
          <Main.Topbar.Right.Target />
          <div className="hidden shrink-0 items-center justify-end gap-1 md:flex">
            {entity && (
              <>
                <DevAgentControl virtualMcp={entity} />
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

      <Main.Content className="overflow-hidden">
        <ErrorBoundary key={routeView}>
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
    </Main>
  );
}
