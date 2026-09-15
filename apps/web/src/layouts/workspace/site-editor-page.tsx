import { Outlet } from "@tanstack/react-router";
import { ChatModeRow } from "@/components/chat/pills/chat-mode-row";
import { useOptionalChatTask } from "@/components/chat/context";
import { CmsHeaderActions } from "@/components/thread/github/cms-header-actions";
import { HeaderActions } from "@/components/thread/github/header-actions";
import {
  agentHasClonableSource,
  agentShowsGithubHeaderActions,
} from "@/lib/agent-capabilities";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { shouldShowTerminalDrawer } from "@/layouts/main-panel-tabs/terminal-drawer-gate";
import { PreviewDrawerHost } from "@/layouts/main-panel-tabs/preview-drawer-host";
import { WorkspacePage } from "./workspace-page";
import { useWorkspace } from "./workspace-context";

function SiteEditorActions() {
  const { entity } = useWorkspace();
  const currentBranch = useOptionalChatTask()?.currentBranch ?? null;
  const runtime = useSessionRuntime(entity?.id).runtime;
  if (!entity) return null;
  return (
    <>
      <div className="flex min-w-0 shrink items-center justify-end">
        <ChatModeRow virtualMcp={entity} currentBranch={currentBranch} />
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1">
        {agentShowsGithubHeaderActions(entity) &&
          (runtime === "cms" ? (
            <CmsHeaderActions virtualMcpId={entity.id} />
          ) : (
            <HeaderActions virtualMcpId={entity.id} />
          ))}
      </div>
    </>
  );
}

function SiteEditorDrawer() {
  const { entity } = useWorkspace();
  const activeTask = useOptionalChatTask()?.activeTask;
  const activeTabId = useActivePanelTabId();
  const sessionRuntime = useSessionRuntime(entity?.id).runtime;
  const showDrawer = shouldShowTerminalDrawer({
    hasClonableSource:
      agentHasClonableSource(entity?.metadata) ||
      agentHasClonableSource(activeTask?.metadata),
    fastPreviewActive: sessionRuntime === "cms",
    mainTab: activeTabId ?? null,
  });
  return showDrawer ? <PreviewDrawerHost /> : null;
}

/** Preview, Content and Code share a route-owned topbar and runtime context. */
export function SiteEditorPage() {
  return (
    <WorkspacePage
      actions={<SiteEditorActions />}
      drawer={<SiteEditorDrawer />}
    >
      <Outlet />
    </WorkspacePage>
  );
}
