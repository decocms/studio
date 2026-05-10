import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Plus, Zap } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { Page } from "@/web/components/page";
import { EmptyState } from "@/web/components/empty-state.tsx";
import {
  buildDefaultAutomationInput,
  useAutomationActions,
  useAutomations,
} from "@/web/hooks/use-automations";
import { AutomationListRow } from "./automation-list-row";
import { track } from "@/web/lib/posthog-client";

export function AutomationsList({ virtualMcpId }: { virtualMcpId: string }) {
  const navigate = useNavigate();
  const { data: automations = [] } = useAutomations(virtualMcpId);
  const { create } = useAutomationActions();
  const [search, setSearch] = useState("");

  const lowerSearch = search.toLowerCase();
  const filtered = automations.filter((a) =>
    a.name.toLowerCase().includes(lowerSearch),
  );

  const goToDetail = (id: string) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        main: "automation:" + id,
      }),
      replace: true,
    });

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

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-6">
            <Page.Title>Automations</Page.Title>
            <div className="flex flex-wrap items-center justify-between gap-3">
              {automations.length > 0 && (
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="Search automations..."
                  className="w-full md:w-[375px]"
                />
              )}
              <Button size="sm" onClick={handleNew} disabled={create.isPending}>
                <Plus size={14} />
                New automation
              </Button>
            </div>
          </div>

          {automations.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <EmptyState
                image={<Zap size={48} className="text-muted-foreground" />}
                title="No automations yet"
                description="Create your first automation to run this agent on a schedule or in response to events."
                actions={
                  <Button
                    size="sm"
                    onClick={handleNew}
                    disabled={create.isPending}
                  >
                    <Plus size={14} />
                    New automation
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
