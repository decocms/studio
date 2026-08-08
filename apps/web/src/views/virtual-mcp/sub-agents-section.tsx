/**
 * Sub-agents section for the agent (Virtual MCP) settings page.
 *
 * Controls which other agents this one may delegate to via the `subtask`
 * tool. The allowlist is stored on `metadata.subAgents`:
 *   - null/absent  → "Any agent" (delegate to all active org agents)
 *   - [ids...]     → "Specific agents" (only those)
 *   - []           → "Only itself" (no cross-agent delegation)
 */

import { IntegrationIcon } from "@/components/integration-icon.tsx";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { Button } from "@decocms/ui/components/button.tsx";
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { useProjectContext, useVirtualMCPs } from "@/sdk";
import { Plus, XClose } from "@untitledui/icons";
import { useState } from "react";
import { useT } from "@/i18n/use-t.ts";
import type { VirtualMcpFormReturn } from "./types";

type Mode = "all" | "selected" | "self";

function modeOf(value: string[] | null | undefined): Mode {
  if (value == null) return "all";
  return value.length === 0 ? "self" : "selected";
}

export function SubAgentsSection({
  form,
  currentAgentId,
}: {
  form: VirtualMcpFormReturn;
  currentAgentId: string;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const allAgents = useVirtualMCPs();
  const [pickerOpen, setPickerOpen] = useState(false);

  // Local optimistic state. This field is edited only here, so local state
  // owns the UI source of truth — clicks update instantly, decoupled from the
  // form-watch subscription and the autosave's query invalidation — while
  // form.setValue persists in the background. Mode is tracked explicitly so
  // "Specific agents" with nothing selected yet doesn't collapse to "self".
  const initial = form.getValues("metadata.subAgents") ?? null;
  const [mode, setMode] = useState<Mode>(() => modeOf(initial));
  const [selectedIds, setSelectedIds] = useState<string[]>(initial ?? []);

  // Candidates: active agents in the org, excluding this agent itself and the
  // org-admin agent (whose id equals the org id).
  const candidates = allAgents.filter(
    (a) => a.id !== currentAgentId && a.id !== org.id && a.status === "active",
  );

  const selectedAgents = candidates.filter((a) => selectedIds.includes(a.id));

  const persist = (nextMode: Mode, nextIds: string[]) =>
    form.setValue(
      "metadata.subAgents",
      nextMode === "all" ? null : nextMode === "self" ? [] : nextIds,
      { shouldDirty: true },
    );

  const handleModeChange = (next: Mode) => {
    setMode(next);
    persist(next, selectedIds);
  };

  const handleToggle = (id: string) => {
    const next = selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id];
    setSelectedIds(next);
    persist("selected", next);
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium text-foreground">
            {t("virtualMcp.subAgentsSection.title")}
          </h2>
          {mode === "all" && (
            <p className="text-sm text-muted-foreground">
              {t("virtualMcp.subAgentsSection.canDelegateToAnyAgent")}
            </p>
          )}
          {mode === "self" && (
            <p className="text-sm text-muted-foreground">
              {t("virtualMcp.subAgentsSection.canOnlyDelegateToItself")}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {mode === "selected" && selectedAgents.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPickerOpen(true)}
            >
              <Plus size={14} />
              {t("virtualMcp.subAgentsSection.addSubAgent")}
            </Button>
          )}
          <Select
            value={mode}
            onValueChange={(v) => handleModeChange(v as Mode)}
          >
            <SelectTrigger size="sm" className="w-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="all">
                {t("virtualMcp.subAgentsSection.anyAgent")}
              </SelectItem>
              <SelectItem value="selected">
                {t("virtualMcp.subAgentsSection.specificAgents")}
              </SelectItem>
              <SelectItem value="self">
                {t("virtualMcp.subAgentsSection.onlyItself")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {mode === "selected" &&
          (selectedAgents.length > 0 ? (
            selectedAgents.map((agent) => (
              <div
                key={agent.id}
                className="flex items-center gap-3 px-4 py-3 rounded-xl border bg-background"
              >
                <IntegrationIcon
                  icon={agent.icon}
                  name={agent.title}
                  size="sm"
                  className="shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{agent.title}</p>
                  {agent.description && (
                    <p className="text-xs text-muted-foreground truncate">
                      {agent.description}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleToggle(agent.id)}
                >
                  <XClose size={16} />
                </Button>
              </div>
            ))
          ) : (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-dashed border-border hover:bg-accent/50 transition-colors w-full text-left cursor-pointer"
            >
              <div className="flex items-center justify-center size-8 rounded-md text-muted-foreground/75 border border-dashed border-border shrink-0">
                <Plus size={16} />
              </div>
              <span className="text-sm text-muted-foreground">
                {t("virtualMcp.subAgentsSection.emptyStateMessage")}
              </span>
            </button>
          ))}
      </div>

      <SubAgentsPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        candidates={candidates}
        selectedIds={selectedIds}
        onToggle={handleToggle}
      />
    </section>
  );
}

function SubAgentsPickerDialog({
  open,
  onOpenChange,
  candidates,
  selectedIds,
  onToggle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: VirtualMCPEntity[];
  selectedIds: string[];
  onToggle: (id: string) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const lower = search.toLowerCase();
  const filtered = candidates.filter(
    (a) =>
      a.title.toLowerCase().includes(lower) ||
      a.description?.toLowerCase().includes(lower),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("virtualMcp.subAgentsSection.title")}</DialogTitle>
        </DialogHeader>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t("virtualMcp.subAgentsSection.searchPlaceholder")}
          className="w-full"
        />
        <div className="flex flex-col gap-1 max-h-80 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground px-1 py-4 text-center">
              {t("virtualMcp.subAgentsSection.noAgentsFound")}
            </p>
          ) : (
            filtered.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => onToggle(agent.id)}
                className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-accent/50 transition-colors cursor-pointer w-full text-left"
              >
                <Checkbox
                  checked={selectedIds.includes(agent.id)}
                  className="pointer-events-none"
                  tabIndex={-1}
                />
                <IntegrationIcon
                  icon={agent.icon}
                  name={agent.title}
                  size="sm"
                  className="shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{agent.title}</p>
                  {agent.description && (
                    <p className="text-xs text-muted-foreground truncate">
                      {agent.description}
                    </p>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
