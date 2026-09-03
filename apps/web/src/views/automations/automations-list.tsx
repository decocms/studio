import { useState } from "react";
import { Plus, Zap } from "@untitledui/icons";
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
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";
import { Main } from "@/components/main";

export function AutomationsList({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { openPanel } = usePanelNavigate();
  const { data: automations = [] } = useAutomations(virtualMcpId);
  const { create } = useAutomationActions();
  const [search, setSearch] = useState("");

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
      size="sm"
      onClick={handleNew}
      disabled={create.isPending}
      aria-label={t("automations.automationsList.newAutomation")}
    >
      <Plus size={14} />
      <span className="@max-sm/main-topbar:hidden">
        {t("automations.automationsList.newAutomation")}
      </span>
    </Button>
  );

  const searchInput =
    automations.length > 0 ? (
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder={t("automations.automationsList.searchPlaceholder")}
        className="w-[clamp(7rem,35cqw,23.4375rem)]"
      />
    ) : null;

  return (
    <Page>
      {searchInput && (
        <Main.Topbar.Center.Portal>
          <div className="hidden md:block">{searchInput}</div>
        </Main.Topbar.Center.Portal>
      )}
      {searchInput && (
        <Main.Subheader.Portal>
          <div className="w-full md:hidden [&>*]:w-full">{searchInput}</div>
        </Main.Subheader.Portal>
      )}
      <Main.Topbar.Right.Portal>{newButton}</Main.Topbar.Right.Portal>
      <Page.Content>
        <Page.Body className="pt-6 md:pt-8">
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
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
