import { useState } from "react";
import { Plus, Zap } from "@untitledui/icons";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Page } from "@/web/components/page";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { useAutomations } from "@/web/hooks/use-automations";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { AutomationListRow } from "@/web/views/automations/automation-list-row";
import {
  getDecopilotId,
  useVirtualMCPs,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { track } from "@/web/lib/posthog-client";

export default function SettingsAutomationsPage() {
  const { org } = useProjectContext();
  const { data: automations = [] } = useAutomations(undefined);
  const agents = useVirtualMCPs();
  const navigateToAgent = useNavigateToAgent();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const lowerSearch = search.toLowerCase();
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const filtered = automations.filter((a) => {
    if (!lowerSearch) return true;
    if (a.name.toLowerCase().includes(lowerSearch)) return true;
    const agent = agentMap.get(a.virtual_mcp_id);
    if (agent && agent.title.toLowerCase().includes(lowerSearch)) return true;
    return false;
  });

  const handleRowClick = (automationId: string, agentId: string) => {
    // Fall back to Decopilot when the automation's virtual_mcp_id no longer
    // resolves (orphaned reference); otherwise the detail panel can't mount.
    const target = agentMap.has(agentId) ? agentId : getDecopilotId(org.id);
    track("automations_list_row_clicked", {
      automation_id: automationId,
      agent_id: target,
      source: "settings_automations",
    });
    navigateToAgent(target, {
      search: { main: "automation:" + automationId },
    });
  };

  const handleBrowseAgents = () => {
    track("automations_empty_state_browse_agents_clicked");
    navigate({ to: "/$org/settings/agents", params: { org: org.slug } });
  };

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-6">
            <Page.Title>Automations</Page.Title>
            {automations.length > 0 && (
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search automations..."
                className="w-full md:w-[375px]"
              />
            )}
          </div>

          {automations.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <EmptyState
                image={<Zap size={48} className="text-muted-foreground" />}
                title="No automations yet"
                description="Automations are created per agent. Open an agent and add one from its Automations tab."
                actions={
                  <Button size="sm" onClick={handleBrowseAgents}>
                    <Plus size={14} />
                    Browse agents
                  </Button>
                }
              />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <EmptyState
                image={<Zap size={48} className="text-muted-foreground" />}
                title="No automations found"
                description={`No automations match "${search}"`}
              />
            </div>
          ) : (
            <div className="mt-6 rounded-xl border border-border overflow-hidden">
              {filtered.map((a) => (
                <AutomationListRow
                  key={a.id}
                  automation={a}
                  showAgent
                  onClick={() => handleRowClick(a.id, a.virtual_mcp_id)}
                />
              ))}
            </div>
          )}
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
