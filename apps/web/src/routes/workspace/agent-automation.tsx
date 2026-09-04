import { getRouteApi } from "@tanstack/react-router";
import { AutomationTab } from "@/layouts/main-panel-tabs/automation-tab";
import { automationMatchesRouteAgent } from "@/layouts/main-panel-tabs/automation-route";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { useAutomation } from "@/hooks/use-automations";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t";
import { resolvePanelNavigationSearch } from "@/layouts/main-panel-tabs/panel-navigation-search";
import { AgentRouteMain } from "./agent-route-main";

const route = getRouteApi(
  "/shell/$org/org-shell/agent-shell/agents/$agentId/automations/$automationId",
);

export default function AgentAutomationRoute() {
  const t = useT();
  const { org } = useProjectContext();
  const { automationId } = route.useParams();
  const agentId = useRouteVirtualMcpId();
  const { data: automation } = useAutomation(automationId);
  const routeAutomation =
    automation &&
    automationMatchesRouteAgent(automation.virtual_mcp_id, agentId)
      ? automation
      : null;
  const automationTitle =
    routeAutomation?.name.trim() ||
    t("automations.automationDetail.breadcrumbFallback");

  return (
    <AgentRouteMain
      contentClassName="overflow-hidden"
      title={routeAutomation ? automationTitle : undefined}
      breadcrumbAncestors={
        routeAutomation
          ? [
              {
                id: "automations",
                label: t("automations.automationsList.title"),
                link: {
                  to: "/$org/agents/$agentId/automations",
                  params: { org: org.slug, agentId },
                  search: (previous) =>
                    resolvePanelNavigationSearch({
                      previous,
                      destination: "agent",
                    }),
                },
              },
            ]
          : undefined
      }
    >
      <AutomationTab
        tabId={`automation:${automationId}`}
        routeAgentId={agentId}
      />
    </AgentRouteMain>
  );
}
