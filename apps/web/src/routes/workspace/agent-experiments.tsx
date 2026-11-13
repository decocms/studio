import { Navigate } from "@tanstack/react-router";
import { ChatLayout } from "@/components/chat-layout";
import { SiteDraftActions } from "@/components/site-draft-bar/site-draft-actions";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { useBlocksV8Project } from "@/hooks/use-blocks-v8-project";
import { ExperimentsApp } from "@/layouts/main-panel-tabs/experiments-app";
import { experimentsRouteView } from "@/layouts/main-panel-tabs/experiments-tab-choice";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { useProjectContext } from "@/sdk";

/**
 * A Blocks v8 project's A/B tests, with the site editor's draft bar on top.
 * Any other project goes to Monitor's Experiments view before the app's
 * layout or draft bar mount.
 */
export default function AgentExperimentsRoute() {
  const virtualMcpId = useRouteVirtualMcpId();
  const { org } = useProjectContext();
  // A v7 project's tests stay in Monitor's Experiments view.
  if (experimentsRouteView(useBlocksV8Project(virtualMcpId)) === "monitor") {
    return (
      <Navigate
        to={PROJECT_ROUTE.monitoring}
        params={{ org: org.slug, agentId: virtualMcpId }}
        search={(prev) => ({
          thread: prev.thread,
          sidepanel: prev.sidepanel,
          view: "experiments",
        })}
        replace
      />
    );
  }
  return (
    <ChatLayout.Content actions={<SiteDraftActions blocksOnly />}>
      <ExperimentsApp virtualMcpId={virtualMcpId} />
    </ChatLayout.Content>
  );
}
