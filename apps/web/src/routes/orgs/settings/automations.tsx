import { useState } from "react";
import { Plus, Zap } from "@untitledui/icons";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Page } from "@/components/page";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { SettingsPage } from "@/components/settings/settings-section";
import { useAutomations } from "@/hooks/use-automations";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { AutomationListRow } from "@/views/automations/automation-list-row";
import { getDecopilotId, useVirtualMCPs, useProjectContext } from "@/sdk";
import { useNavigate } from "@tanstack/react-router";
import { track } from "@/lib/posthog-client";
import { RequireCapability } from "@/components/require-capability";
import { useT } from "@/i18n/use-t.ts";

function SettingsAutomationsPage() {
  const t = useT();
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
    if (a.virtual_mcp_id) {
      const agent = agentMap.get(a.virtual_mcp_id);
      if (agent && agent.title.toLowerCase().includes(lowerSearch)) return true;
    }
    return false;
  });

  const handleRowClick = (automationId: string, agentId: string | null) => {
    // Agent-kind rows whose virtual_mcp_id no longer resolves are orphaned;
    // fall back to Decopilot so the detail panel still has a host shell.
    const target =
      agentId && agentMap.has(agentId) ? agentId : getDecopilotId(org.id);
    track("automations_list_row_clicked", {
      automation_id: automationId,
      agent_id: target,
      source: "settings_automations",
    });
    navigateToAgent(target, { panel: `automation:${automationId}` });
  };

  const handleBrowseAgents = () => {
    track("automations_empty_state_browse_agents_clicked");
    navigate({ to: "/$org/settings/projects", params: { org: org.slug } });
  };

  return (
    <Page>
      <Page.Content>
        <Page.Container>
          <SettingsPage className="gap-6">
            <Page.Title>{t("settings.automations.pageTitle")}</Page.Title>
            {automations.length > 0 && (
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder={t("settings.automations.searchPlaceholder")}
                className="w-full md:w-[375px]"
              />
            )}

            {automations.length === 0 ? (
              <EmptyState
                icon={<Zap />}
                title={t("settings.automations.emptyTitle")}
                description={t("settings.automations.emptyDescription")}
                buttonComponent={
                  <Button size="sm" onClick={handleBrowseAgents}>
                    <Plus size={14} />
                    {t("settings.automations.browseAgentsButton")}
                  </Button>
                }
              />
            ) : (
              // Rows draw their own bottom rule; the card drops the last one.
              <div className="surface overflow-hidden [&>*:last-child]:border-b-0">
                {filtered.length === 0 ? (
                  <EmptyState
                    size="sm"
                    title={t("settings.automations.noResultsTitle")}
                    description={t(
                      "settings.automations.noResultsDescription",
                      { search },
                    )}
                  />
                ) : (
                  filtered.map((a) => (
                    <AutomationListRow
                      key={a.id}
                      automation={a}
                      showAgent
                      onClick={() => handleRowClick(a.id, a.virtual_mcp_id)}
                    />
                  ))
                )}
              </div>
            )}
          </SettingsPage>
        </Page.Container>
      </Page.Content>
    </Page>
  );
}

export default function SettingsAutomationsRoute() {
  return (
    <RequireCapability capability="automations:manage" area="automations">
      <SettingsAutomationsPage />
    </RequireCapability>
  );
}
