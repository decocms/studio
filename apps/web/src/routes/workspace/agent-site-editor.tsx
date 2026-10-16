import { Outlet } from "@tanstack/react-router";
import { Separator } from "@decocms/ui/components/separator.tsx";
import { ChatModeRow } from "@/components/chat/pills/chat-mode-row";
import { useOptionalChatTask } from "@/components/chat/context";
import { CmsHeaderActions } from "@/components/thread/repository/cms-header-actions";
import { HeaderActions } from "@/components/thread/repository/header-actions";
import {
  agentHasClonableSource,
  agentShowsRepositoryHeaderActions,
} from "@/lib/agent-capabilities";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { shouldShowTerminalDrawer } from "@/layouts/main-panel-tabs/terminal-drawer-gate";
import { PreviewDrawerHost } from "@/layouts/main-panel-tabs/preview-drawer-host";
import { ChatLayout } from "@/components/chat-layout";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { LocalChangesButton } from "@/components/thread/repository/local-changes-dialog";
import { DecoServeReadOnlyBadge } from "@/components/sections-editor/deco-serve-read-only-badge";
import { useDecoServeConnection } from "@/hooks/use-deco-serve-connection";
import { ContentVersionBadge } from "@/components/sections-editor/content-version-badge";

function SiteEditorActions() {
  const session = useOptionalChatTask();
  const { org } = useProjectContext();
  const entity = useVirtualMCP(session?.virtualMcpId);
  const currentBranch = session?.currentBranch ?? null;
  const runtime = useSessionRuntime(entity?.id).runtime;
  // Local mode edits are ephemeral (nothing to promote) → withhold publish.
  // A saved tunnel waiting for main's answer withholds them too, so a v7
  // site with a tunnel never shows them first and hides them after.
  const { url: localPreviewUrl, undecided: tunnelUndecided } =
    useLocalPreviewUrl(entity?.id);
  // A connected `deco serve` edits the working tree: the developer commits.
  // Outside a project (`/site-editor`) it is the only thing behind the editor.
  const { connection: serveConnection } = useDecoServeConnection(
    entity?.id ?? session?.virtualMcpId,
  );
  const servingLocally = !!serveConnection;
  const virtualMcpId = entity?.id ?? session?.virtualMcpId;
  if (!virtualMcpId || (!entity && !servingLocally)) return null;
  return (
    <>
      <ContentVersionBadge virtualMcpId={virtualMcpId} branch={currentBranch} />
      {servingLocally && (
        <DecoServeReadOnlyBadge
          virtualMcpId={virtualMcpId}
          branch={currentBranch}
        />
      )}
      {servingLocally && (
        // What the editor saved since the last commit; no Publish here.
        <LocalChangesButton
          orgSlug={org.slug}
          virtualMcpId={virtualMcpId}
          branch={currentBranch}
        />
      )}
      {entity && (
        <div className="flex min-w-0 shrink items-center justify-end">
          <ChatModeRow virtualMcp={entity} currentBranch={currentBranch} />
        </div>
      )}
      {entity &&
        !localPreviewUrl &&
        !tunnelUndecided &&
        !servingLocally &&
        agentShowsRepositoryHeaderActions(entity) && (
          <>
            <Separator
              orientation="vertical"
              className="mx-1 data-[orientation=vertical]:h-4"
            />
            <div className="flex shrink-0 items-center justify-end gap-1">
              {runtime === "cms" ? (
                <CmsHeaderActions virtualMcpId={entity.id} />
              ) : (
                <HeaderActions virtualMcpId={entity.id} />
              )}
            </div>
          </>
        )}
    </>
  );
}

function SiteEditorDrawer() {
  const session = useOptionalChatTask();
  const entity = useVirtualMCP(session?.virtualMcpId);
  const activeTask = session?.activeTask;
  const activeTabId = useActivePanelTabId();
  const sessionRuntime = useSessionRuntime(entity?.id).runtime;
  const { url: localPreviewUrl, undecided: tunnelUndecided } =
    useLocalPreviewUrl(entity?.id);
  const { connection: serveConnection } = useDecoServeConnection(
    entity?.id ?? session?.virtualMcpId,
  );
  const servingLocally = !!serveConnection;
  const showDrawer =
    !localPreviewUrl &&
    !tunnelUndecided &&
    !servingLocally &&
    shouldShowTerminalDrawer({
      hasClonableSource:
        agentHasClonableSource(entity?.metadata) ||
        agentHasClonableSource(activeTask?.metadata),
      fastPreviewActive: sessionRuntime === "cms",
      mainTab: activeTabId ?? null,
    });
  return showDrawer ? <PreviewDrawerHost /> : null;
}

/** Preview, Content and Code share a route-owned topbar and runtime context.
 *  The account-less `/site-editor` mounts this same app over a `deco serve`. */
export default function SiteEditorRoute() {
  return (
    <ChatLayout.Content
      actions={<SiteEditorActions />}
      drawer={<SiteEditorDrawer />}
    >
      <Outlet />
    </ChatLayout.Content>
  );
}
