import { useState } from "react";
import { AlertTriangle, Plus, Zap } from "@untitledui/icons";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import { useAutomations } from "@/hooks/use-automations";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { AutomationListRow } from "@/views/automations/automation-list-row";
import { getDecopilotId, useVirtualMCPs, useProjectContext } from "@/sdk";
import { useNavigate } from "@tanstack/react-router";
import { track } from "@/lib/posthog-client";
import { RequireCapability } from "@/components/require-capability";
import { useT } from "@/i18n/use-t.ts";
import { Main } from "@/components/main";

function SettingsAutomationsPage() {
  const t = useT();
  const { org } = useProjectContext();
  const {
    data: automations = [],
    isPending,
    isError,
    refetch,
  } = useAutomations(undefined);
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
    navigateToAgent(target, { view: `automation:${automationId}` });
  };

  const handleBrowseAgents = () => {
    track("automations_empty_state_browse_agents_clicked");
    navigate({ to: "/$org/settings/agents", params: { org: org.slug } });
  };

  const searchInput =
    automations.length > 0 && !isPending && !isError ? (
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder={t("settings.automations.searchPlaceholder")}
        className="w-[clamp(7rem,35cqw,23.4375rem)]"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setSearch("");
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
    ) : null;

  return (
    <>
      {searchInput && (
        <Main.Topbar.Center.Portal>
          <div
            data-responsive-focus-group="settings-automations-search"
            className="hidden md:block"
          >
            {searchInput}
          </div>
        </Main.Topbar.Center.Portal>
      )}
      {searchInput && (
        <Main.Toolbar.Portal visibility="compact">
          <div
            data-responsive-focus-group="settings-automations-search"
            className="w-full md:hidden [&>*]:w-full"
          >
            {searchInput}
          </div>
        </Main.Toolbar.Portal>
      )}
      <div className="h-full overflow-y-auto">
        <Main.Container width="standard">
          <Main.Stack>
            {isPending ? (
              <div
                role="status"
                aria-label={t("common.loading")}
                className="flex min-h-56 items-center justify-center"
              >
                <Spinner className="size-5 text-muted-foreground" />
              </div>
            ) : isError ? (
              <div className="flex min-h-56 items-center justify-center">
                <EmptyState
                  image={
                    <AlertTriangle
                      size={48}
                      className="text-muted-foreground"
                    />
                  }
                  title={t("settings.automations.errorTitle")}
                  description={t("settings.automations.errorDescription")}
                  actions={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void refetch()}
                    >
                      {t("settings.automations.retry")}
                    </Button>
                  }
                />
              </div>
            ) : automations.length === 0 ? (
              <div className="flex min-h-56 items-center justify-center">
                <EmptyState
                  image={<Zap size={48} className="text-muted-foreground" />}
                  title={t("settings.automations.emptyTitle")}
                  description={t("settings.automations.emptyDescription")}
                  actions={
                    <Button size="sm" onClick={handleBrowseAgents}>
                      <Plus size={14} />
                      {t("settings.automations.browseAgentsButton")}
                    </Button>
                  }
                />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex min-h-56 items-center justify-center">
                <EmptyState
                  image={<Zap size={48} className="text-muted-foreground" />}
                  title={t("settings.automations.noResultsTitle")}
                  description={t("settings.automations.noResultsDescription", {
                    search,
                  })}
                />
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-border">
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
          </Main.Stack>
        </Main.Container>
      </div>
    </>
  );
}

export default function SettingsAutomationsRoute() {
  const t = useT();
  return (
    <RequireCapability
      capability="automations:manage"
      area={t("settings.nav.automations")}
    >
      <SettingsAutomationsPage />
    </RequireCapability>
  );
}
