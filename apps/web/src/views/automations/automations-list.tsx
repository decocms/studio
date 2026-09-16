import { useState } from "react";
import { Plus, Settings01, Zap } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { Page } from "@/components/page";
import { EmptyState } from "@/components/empty-state.tsx";
import {
  buildDefaultAutomationInput,
  useAutomationActions,
  useAutomations,
} from "@/hooks/use-automations";
import { usePanelNavigate } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { AutomationListRow } from "./automation-list-row";
import { isAutomationsNotConfiguredError } from "./automations-error";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

export function AutomationsList({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { openPanel } = usePanelNavigate();
  const { data: automations = [], error } = useAutomations(virtualMcpId);
  const { create } = useAutomationActions();
  const [search, setSearch] = useState("");

  // Only the missing-relation case gets the setup prompt; any other error keeps surfacing as an error.
  if (error && isAutomationsNotConfiguredError(error)) {
    return (
      <Page>
        <Page.Content>
          <Page.Container>
            <div className="flex items-center justify-center py-20">
              <EmptyState
                image={
                  <Settings01 size={48} className="text-muted-foreground" />
                }
                title={t("automations.setupRequired.title")}
                description={t("automations.setupRequired.description")}
                actions={
                  <Button size="sm" onClick={() => openPanel("settings")}>
                    {t("automations.setupRequired.goToSetup")}
                  </Button>
                }
              />
            </div>
          </Page.Container>
        </Page.Content>
      </Page>
    );
  }

  const lowerSearch = search.toLowerCase();
  const filtered = automations.filter((a) =>
    a.name.toLowerCase().includes(lowerSearch),
  );

  const goToDetail = (id: string) => openPanel(`automation:${id}`);

  const handleNew = async () => {
    if (create.isPending) return;
    track("automation_new_clicked", {
      virtual_mcp_id: virtualMcpId,
      existing_count: automations.length,
    });
    const created = await create.mutateAsync(
      buildDefaultAutomationInput(virtualMcpId),
    );
    goToDetail(created.id);
  };

  const newButton = (
    <Button
      variant="brand"
      size="sm"
      onClick={handleNew}
      disabled={create.isPending}
    >
      <Plus size={14} />
      {t("automations.automationsList.newAutomation")}
    </Button>
  );

  return (
    <Page>
      <Page.Content>
        <Page.Container>
          <div className="flex flex-col gap-6">
            <Page.Title actions={newButton}>
              {t("automations.automationsList.title")}
            </Page.Title>
            <div className="flex flex-wrap items-center justify-between gap-3">
              {automations.length > 0 && (
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder={t(
                    "automations.automationsList.searchPlaceholder",
                  )}
                  className="w-full md:w-[375px]"
                />
              )}
            </div>
          </div>

          {automations.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <EmptyState
                image={<Zap size={48} className="text-muted-foreground" />}
                title={t("automations.automationsList.emptyTitle")}
                description={t("automations.automationsList.emptyDescription")}
              />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <EmptyState
                image={<Zap size={48} className="text-muted-foreground" />}
                title={t("automations.automationsList.noResultsTitle")}
                description={t(
                  "automations.automationsList.noResultsDescription",
                  { search },
                )}
              />
            </div>
          ) : (
            <div className="mt-6 rounded-xl border border-border overflow-hidden">
              {filtered.map((a) => (
                <AutomationListRow
                  key={a.id}
                  automation={a}
                  onClick={() => goToDetail(a.id)}
                />
              ))}
            </div>
          )}
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
