import { useState } from "react";
import { Plus, Zap } from "@untitledui/icons";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Page } from "@/web/components/page";
import { EmptyState } from "@/web/components/empty-state.tsx";
import {
  buildDefaultToolCallAutomationInput,
  useAutomationActions,
  useAutomations,
} from "@/web/hooks/use-automations";
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
  const { create } = useAutomationActions();

  const handleCreateToolCall = async () => {
    if (create.isPending) return;
    track("automations_new_tool_call_clicked", {
      existing_count: automations.length,
    });
    const created = await create.mutateAsync(
      buildDefaultToolCallAutomationInput(),
    );
    // tool_call automations have no agent; route the detail panel through
    // Decopilot as the host shell (same fallback as orphaned agent refs).
    handleRowClick(created.id, null);
  };

  const lowerSearch = search.toLowerCase();
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const filtered = automations.filter((a) => {
    if (!lowerSearch) return true;
    if (a.name.toLowerCase().includes(lowerSearch)) return true;
    if (a.virtual_mcp_id) {
      const agent = agentMap.get(a.virtual_mcp_id);
      if (agent && agent.title.toLowerCase().includes(lowerSearch)) return true;
    }
    if (a.tool_name?.toLowerCase().includes(lowerSearch)) return true;
    return false;
  });

  const handleRowClick = (automationId: string, agentId: string | null) => {
    // Tool-call automations have no agent (virtual_mcp_id=null), and an
    // agent-kind row whose virtual_mcp_id no longer resolves is orphaned —
    // either way the detail panel needs a host shell, so we fall back to
    // Decopilot.
    const target =
      agentId && agentMap.has(agentId) ? agentId : getDecopilotId(org.id);
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Page.Title>Automations</Page.Title>
              <Button
                size="sm"
                variant="outline"
                onClick={handleCreateToolCall}
                disabled={create.isPending}
              >
                <Plus size={14} />
                New tool-call automation
              </Button>
            </div>
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
