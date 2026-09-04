import { useState } from "react";
import { AlertTriangle, Plus, Zap } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
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
  const {
    data: automations = [],
    isPending,
    isError,
    refetch,
  } = useAutomations(virtualMcpId);
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
    automations.length > 0 && !isPending && !isError ? (
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder={t("automations.automationsList.searchPlaceholder")}
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
            data-responsive-focus-group="automations-search"
            className="hidden md:block"
          >
            {searchInput}
          </div>
        </Main.Topbar.Center.Portal>
      )}
      {searchInput && (
        <Main.Toolbar.Portal visibility="compact">
          <div
            data-responsive-focus-group="automations-search"
            className="w-full md:hidden [&>*]:w-full"
          >
            {searchInput}
          </div>
        </Main.Toolbar.Portal>
      )}
      <Main.Topbar.Right.Portal>{newButton}</Main.Topbar.Right.Portal>
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
                  title={t("automations.automationsList.errorTitle")}
                  description={t(
                    "automations.automationsList.errorDescription",
                  )}
                  actions={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void refetch()}
                    >
                      {t("automations.automationsList.retry")}
                    </Button>
                  }
                />
              </div>
            ) : automations.length === 0 ? (
              <div className="flex min-h-56 items-center justify-center">
                <EmptyState
                  image={<Zap size={48} className="text-muted-foreground" />}
                  title={t("automations.automationsList.emptyTitle")}
                  description={t(
                    "automations.automationsList.emptyDescription",
                  )}
                />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex min-h-56 items-center justify-center">
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
              <div className="overflow-hidden rounded-xl border border-border">
                {filtered.map((a) => (
                  <AutomationListRow
                    key={a.id}
                    automation={a}
                    onClick={() => goToDetail(a.id)}
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
