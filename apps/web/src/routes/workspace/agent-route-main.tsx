import { MainPanelTabsBar } from "@/layouts/main-panel-tabs/main-panel-tabs-bar";
import { useWorkspace } from "@/layouts/agent-shell-layout/workspace-context";
import { DevAgentControl } from "@/components/dev-agent/dev-agent-control";
import { useRouteMainTitle } from "@/hooks/use-route-main-title";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import {
  getDecopilotId,
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
} from "@/sdk";
import { useT } from "@/i18n/use-t";
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
  props: Omit<WorkspaceRouteMainProps, "leading" | "hideTitle"> & {
    /** The project's Home uses its name as a visually hidden page title. */
    agentRoot?: boolean;
  },
) {
  const { agentRoot = false, ...routeProps } = props;
  const t = useT();
  const workspace = useWorkspace();
  const { org } = useProjectContext();
  const agentId = useRouteVirtualMcpId();
  const agent = useVirtualMCP(agentId);
  const titleAgent =
    agent ??
    (agentId === getDecopilotId(org.id)
      ? getWellKnownDecopilotVirtualMCP(org.id)
      : { id: agentId, title: t("taskBoard.taskDialog.projectLabel") });
  const fixedRouteTitle = useRouteMainTitle();
  const projectTitle =
    titleAgent.title.trim() || t("taskBoard.taskDialog.projectLabel");
  const routeTitle = agentRoot
    ? projectTitle
    : routeProps.title?.trim() || fixedRouteTitle;

  return (
    <WorkspaceRouteMain
      {...routeProps}
      title={routeTitle}
      hideTitle={agentRoot}
      actions={
        <>
          {routeProps.actions}
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
