import { Outlet } from "@tanstack/react-router";
import { useOptionalChatTask } from "@/components/chat/context";
import { SiteDraftActions } from "@/components/site-draft-bar/site-draft-actions";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { shouldShowTerminalDrawer } from "@/layouts/main-panel-tabs/terminal-drawer-gate";
import { PreviewDrawerHost } from "@/layouts/main-panel-tabs/preview-drawer-host";
import { ChatLayout } from "@/components/chat-layout";
import { useVirtualMCP } from "@/sdk";
import { useDecoServeConnection } from "@/hooks/use-deco-serve-connection";

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

/** Preview, Content and Code share a route-owned topbar (the site's draft
 *  bar, also on Experiments and Calendar) and runtime context.
 *  The account-less `/site-editor` mounts this same app over a `deco serve`. */
export default function SiteEditorRoute() {
  return (
    <ChatLayout.Content
      actions={<SiteDraftActions />}
      drawer={<SiteEditorDrawer />}
    >
      <Outlet />
    </ChatLayout.Content>
  );
}
