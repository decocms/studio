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
import { projectMainBreadcrumbItem } from "@/components/main-breadcrumb/route-items";
import type { MainBreadcrumbNavigableItem } from "@/components/main-breadcrumb";
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
  props: Omit<
    WorkspaceRouteMainProps,
    "breadcrumbAncestors" | "breadcrumbScope" | "leading"
  > & {
    /** Use the project's name as the current title on its overview route. */
    agentRoot?: boolean;
    /** Semantic route levels nested below the agent. */
    breadcrumbAncestors?: readonly MainBreadcrumbNavigableItem[];
  },
) {
  const { agentRoot = false, breadcrumbAncestors = [], ...routeProps } = props;
  const t = useT();
  const workspace = useWorkspace();
  const { org } = useProjectContext();
  const agentId = useRouteVirtualMcpId();
  const agent = useVirtualMCP(agentId);
  const breadcrumbAgent =
    agent ??
    (agentId === getDecopilotId(org.id)
      ? getWellKnownDecopilotVirtualMCP(org.id)
      : {
          id: agentId,
          title: t("taskBoard.taskDialog.projectLabel"),
          icon: null,
        });
  const fixedRouteTitle = useRouteMainTitle();
  const projectTitle =
    breadcrumbAgent.title.trim() || t("taskBoard.taskDialog.projectLabel");
  const routeTitle = agentRoot
    ? projectTitle
    : routeProps.title?.trim() || fixedRouteTitle;
  const projectScope = projectMainBreadcrumbItem(
    org.slug,
    breadcrumbAgent,
    t("taskBoard.taskDialog.projectLabel"),
  );

  return (
    <WorkspaceRouteMain
      {...routeProps}
      title={routeTitle}
      breadcrumbScope={projectScope}
      breadcrumbAncestors={breadcrumbAncestors}
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
