import { MainPanelTabsBar } from "@/layouts/main-panel-tabs/main-panel-tabs-bar";
import { useWorkspace } from "@/layouts/agent-shell-layout/workspace-context";
import { DevAgentControl } from "@/components/dev-agent/dev-agent-control";
import { useRouteMainTitle } from "@/hooks/use-route-main-title";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { useVirtualMCP } from "@/sdk";
import {
  WorkspaceRouteMain,
  type WorkspaceRouteMainProps,
} from "./workspace-route-main";

/**
 * Agent routes opt into their contextual/per-thread navigation explicitly.
 * Organization routes use WorkspaceRouteMain directly, so the shared Main
 * primitive never guesses its composition from router params.
 */
export function AgentRouteMain(
  props: Omit<WorkspaceRouteMainProps, "leading">,
) {
  const workspace = useWorkspace();
  const agentId = useRouteVirtualMcpId();
  const agent = useVirtualMCP(agentId);
  const fixedRouteTitle = useRouteMainTitle();
  const routeTitle = props.title?.trim() || fixedRouteTitle;

  return (
    <WorkspaceRouteMain
      {...props}
      actions={
        <>
          {props.actions}
          {agent ? <DevAgentControl virtualMcp={agent} /> : null}
        </>
      }
      leading={
        <div className="hidden min-w-0 overflow-hidden md:block">
          <MainPanelTabsBar
            disableActiveMainToggle={!workspace.sidePanelOpen}
            omitActiveTab={Boolean(routeTitle)}
          />
        </div>
      }
    />
  );
}
