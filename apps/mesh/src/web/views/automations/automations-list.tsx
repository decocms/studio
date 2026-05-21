import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Plus, Stars01, Tool02, Zap } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { Page } from "@/web/components/page";
import { EmptyState } from "@/web/components/empty-state.tsx";
import {
  buildDefaultAutomationInput,
  buildDefaultToolCallAutomationInput,
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

  const handleNewToolCall = async () => {
    if (create.isPending) return;
    track("automation_new_tool_call_clicked", {
      // Tool-call automations aren't scoped to an agent (kind='tool_call'
      // rows have virtual_mcp_id=null), so they won't appear in this
      // agent's tab after creation — they live at the org level. We log
      // the source agent here for analytics.
      source_virtual_mcp_id: virtualMcpId,
      existing_count: automations.length,
    });
    const created = await create.mutateAsync(
      buildDefaultToolCallAutomationInput(),
    );
    goToDetail(created.id);
  };

  const newButton = (
    <div className="flex items-stretch">
      <Button
        size="sm"
        onClick={handleNew}
        disabled={create.isPending}
        className="rounded-r-none"
      >
        <Plus size={14} />
        New automation
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            disabled={create.isPending}
            className="rounded-l-none border-l border-primary-foreground/20 px-2"
            aria-label="Pick automation kind"
          >
            <ChevronDown size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem onClick={handleNew} disabled={create.isPending}>
            <Stars01 size={14} />
            <div className="flex flex-col">
              <span>Agent automation</span>
              <span className="text-xs text-muted-foreground">
                Runs this agent on a schedule or event
              </span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={handleNewToolCall}
            disabled={create.isPending}
          >
            <Tool02 size={14} />
            <div className="flex flex-col">
              <span>Tool-call automation</span>
              <span className="text-xs text-muted-foreground">
                Invokes a fixed MCP tool — no agent, no LLM
              </span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

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
              {newButton}
            </div>
          </div>

          {automations.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <EmptyState
                image={<Zap size={48} className="text-muted-foreground" />}
                title="No automations yet"
                description="Create your first automation to run this agent on a schedule or in response to events."
                actions={newButton}
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
