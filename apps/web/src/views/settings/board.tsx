/**
 * Board settings (/$org/settings/board) — customize the task board: columns
 * (rename, add, reorder, per-column agent automation) and the optional sprint
 * and release features. The default board stays untouched until saved here.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Page } from "@/components/page";
import {
  SettingsCard,
  SettingsPage,
  SettingsSection,
} from "@/components/settings/settings-section";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Lightning01,
  Plus,
  Trash03,
} from "@untitledui/icons";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import { useVirtualMCPs } from "@/sdk";
import { AgentAvatar } from "@/components/agent-icon";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import {
  useTaskBoardSettings,
  useUpdateTaskBoardSettings,
  type TaskBoardColumnConfig,
  type TaskBoardSettingsConfig,
} from "@/hooks/use-organization-settings";
import {
  DEFAULT_TASK_BOARD_COLUMNS,
  resolveBoardColumns,
  TASK_BOARD_STAGES,
} from "@decocms/shared/task-board-columns";
import { STATUS_CONFIG } from "@/layouts/task-board/config";
import type { TaskBoardItemStatus } from "@decocms/shared/entities";

function stageLabel(stage: TaskBoardItemStatus, t: TFunction): string {
  return t(STATUS_CONFIG[stage].labelKey);
}

/** Editable copy of a column row (name empty = use the stage's label). */
type ColumnDraft = {
  id: string;
  name: string;
  stage: TaskBoardItemStatus;
  automationEnabled: boolean;
  automationAgentId: string | null;
};

function toDrafts(columns: TaskBoardColumnConfig[]): ColumnDraft[] {
  return columns.map((c) => ({
    id: c.id,
    name: c.name ?? "",
    stage: c.stage,
    automationEnabled: c.automation?.enabled ?? false,
    automationAgentId: c.automation?.agentId ?? null,
  }));
}

function fromDrafts(drafts: ColumnDraft[]): TaskBoardColumnConfig[] {
  return drafts.map((d) => ({
    id: d.id,
    name: (d.name ?? "").trim() || null,
    stage: d.stage,
    ...(d.automationEnabled || d.automationAgentId
      ? {
          automation: {
            enabled: d.automationEnabled,
            agentId: d.automationAgentId,
          },
        }
      : {}),
  }));
}

export function BoardSettingsPage() {
  const t = useT();
  const settings = useTaskBoardSettings();
  const update = useUpdateTaskBoardSettings();

  const saved: TaskBoardSettingsConfig = settings ?? {
    columns: null,
    sprintsEnabled: false,
    releasesEnabled: false,
  };
  const [drafts, setDrafts] = useState<ColumnDraft[]>(() =>
    toDrafts(resolveBoardColumns(saved.columns)),
  );
  const sprintsEnabled = saved.sprintsEnabled ?? false;
  const releasesEnabled = saved.releasesEnabled ?? false;

  const patch = (index: number, data: Partial<ColumnDraft>) =>
    setDrafts((prev) =>
      prev.map((d, i) => (i === index ? { ...d, ...data } : d)),
    );
  const move = (index: number, delta: -1 | 1) =>
    setDrafts((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      const [row] = next.splice(index, 1);
      next.splice(target, 0, row!);
      return next;
    });

  // Shared save feedback — every board-settings write toasts success/failure.
  const toastResult = {
    onSuccess: () => toast.success(t("settings.board.saved")),
    onError: () => toast.error(t("settings.board.saveFailed")),
  };

  const saveColumns = () =>
    update.mutate({ ...saved, columns: fromDrafts(drafts) }, toastResult);
  const resetColumns = () => {
    setDrafts(toDrafts(DEFAULT_TASK_BOARD_COLUMNS));
    update.mutate({ ...saved, columns: null }, toastResult);
  };
  const setToggle = (
    key: "sprintsEnabled" | "releasesEnabled",
    value: boolean,
  ) => update.mutate({ ...saved, [key]: value }, toastResult);

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>{t("settings.board.title")}</Page.Title>

            <SettingsSection
              title={t("settings.board.columnsTitle")}
              description={t("settings.board.columnsDescription")}
              actions={
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={resetColumns}
                    disabled={update.isPending}
                  >
                    {t("settings.board.resetColumns")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={saveColumns}
                    disabled={update.isPending || drafts.length === 0}
                  >
                    {t("settings.board.saveColumns")}
                  </Button>
                </div>
              }
            >
              <SettingsCard>
                {drafts.map((draft, index) => (
                  <ColumnRow
                    key={draft.id}
                    draft={draft}
                    isFirst={index === 0}
                    isLast={index === drafts.length - 1}
                    canDelete={drafts.length > 1}
                    onChange={(data) => patch(index, data)}
                    onMoveUp={() => move(index, -1)}
                    onMoveDown={() => move(index, 1)}
                    onDelete={() =>
                      setDrafts((prev) => prev.filter((_, i) => i !== index))
                    }
                  />
                ))}
                <div className="px-5 py-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDrafts((prev) => [
                        ...prev,
                        {
                          id: crypto.randomUUID(),
                          name: "",
                          stage: "todo",
                          automationEnabled: false,
                          automationAgentId: null,
                        },
                      ])
                    }
                  >
                    <Plus size={14} />
                    {t("settings.board.addColumn")}
                  </Button>
                </div>
              </SettingsCard>
            </SettingsSection>

            <SettingsSection
              title={t("settings.board.featuresTitle")}
              description={t("settings.board.featuresDescription")}
            >
              <SettingsCard>
                <div className="flex items-center justify-between gap-3 px-5 py-4">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium text-foreground">
                      {t("settings.board.sprintsToggle")}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {t("settings.board.sprintsToggleDescription")}
                    </span>
                  </div>
                  <Switch
                    checked={sprintsEnabled}
                    onCheckedChange={(checked) =>
                      setToggle("sprintsEnabled", checked)
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-3 px-5 py-4">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium text-foreground">
                      {t("settings.board.releasesToggle")}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {t("settings.board.releasesToggleDescription")}
                    </span>
                  </div>
                  <Switch
                    checked={releasesEnabled}
                    onCheckedChange={(checked) =>
                      setToggle("releasesEnabled", checked)
                    }
                  />
                </div>
              </SettingsCard>
            </SettingsSection>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}

function ColumnRow({
  draft,
  isFirst,
  isLast,
  canDelete,
  onChange,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  draft: ColumnDraft;
  isFirst: boolean;
  isLast: boolean;
  canDelete: boolean;
  onChange: (data: Partial<ColumnDraft>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const agents = useVirtualMCPs() ?? [];
  const selectedAgent = draft.automationAgentId
    ? agents.find((a) => a.id === draft.automationAgentId)
    : null;
  const agentName =
    selectedAgent?.title ??
    (draft.automationAgentId
      ? t("settings.board.automationAgentUnknown")
      : t("settings.board.automationSuperAgent"));

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-col">
          <button
            type="button"
            aria-label={t("settings.board.moveColumnUpAriaLabel")}
            onClick={onMoveUp}
            disabled={isFirst}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            <ArrowUp size={13} />
          </button>
          <button
            type="button"
            aria-label={t("settings.board.moveColumnDownAriaLabel")}
            onClick={onMoveDown}
            disabled={isLast}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            <ArrowDown size={13} />
          </button>
        </div>
        <Input
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={stageLabel(draft.stage, t)}
          className="h-9 w-48"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-foreground transition-colors hover:bg-muted"
            >
              <span className="text-muted-foreground">
                {t("settings.board.stageLabel")}
              </span>
              {stageLabel(draft.stage, t)}
              <ChevronDown size={12} className="opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            {TASK_BOARD_STAGES.map((stage) => (
              <DropdownMenuItem
                key={stage}
                onSelect={() => onChange({ stage })}
              >
                {stageLabel(stage, t)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label={t("settings.board.deleteColumnAriaLabel")}
          onClick={onDelete}
          disabled={!canDelete}
          className="ml-auto text-muted-foreground transition-colors hover:text-destructive disabled:opacity-30"
        >
          <Trash03 size={15} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-6">
        <span
          className={cn(
            "flex items-center gap-1.5 text-sm",
            draft.automationEnabled
              ? "text-foreground"
              : "text-muted-foreground",
          )}
        >
          <Lightning01 size={14} />
          {t("settings.board.automationLabel")}
        </span>
        <Switch
          checked={draft.automationEnabled}
          onCheckedChange={(checked) =>
            onChange({ automationEnabled: checked })
          }
        />
        {draft.automationEnabled && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-sm text-foreground transition-colors hover:bg-muted"
              >
                {selectedAgent ? (
                  <AgentAvatar
                    icon={selectedAgent.icon}
                    name={selectedAgent.title}
                    size="2xs"
                  />
                ) : (
                  <SuperAgentIcon size={14} />
                )}
                <span className="max-w-52 truncate">{agentName}</span>
                <ChevronDown size={12} className="opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-72 w-60 overflow-y-auto"
            >
              <DropdownMenuItem
                onSelect={() => onChange({ automationAgentId: null })}
                className="gap-2"
              >
                <SuperAgentIcon size={14} className="shrink-0" />
                {t("settings.board.automationSuperAgent")}
              </DropdownMenuItem>
              {agents.map((agent) => (
                <DropdownMenuItem
                  key={agent.id}
                  onSelect={() => onChange({ automationAgentId: agent.id })}
                  className="gap-2"
                >
                  <AgentAvatar
                    icon={agent.icon}
                    name={agent.title}
                    size="2xs"
                    className="shrink-0"
                  />
                  <span className="truncate">{agent.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
