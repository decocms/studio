/**
 * Settings → Tasks → "Board columns", for a board whose columns are the org's
 * own.
 *
 * One row per column, answering both questions a column raises at once: what
 * it MEANS to Studio, and whether a card arriving there starts the agent.
 * These were two sections listing the same columns, which read as two settings
 * when they are two halves of one.
 *
 * The distinction the rows have to carry: a meaning is a PLACE the lifecycle
 * puts a card, and only the toggle starts anything. Nothing in the meaning
 * column runs an agent, however much "queued" sounds like it.
 *
 * Studio's own board has no section here at all — its lifecycle is decided,
 * and offering the same switches per canonical lane would invite a team to
 * turn off what makes the board work.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Input } from "@decocms/ui/components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useOrgFlag } from "@/hooks/use-organization-settings";
import { useSetColumnRole } from "@/hooks/use-jira-integration";
import { useTaskBoardItems } from "@/hooks/use-task-board-items";
import {
  useColumnAutomations,
  useSetColumnAutomation,
} from "@/hooks/use-column-automations";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { useT } from "@/i18n/use-t.ts";

/** No meaning — the honest default for a column nobody has told us about. */
const NO_ROLE = "__none__";

/** Every meaning a column can carry, each one a PLACE in the agent's
 *  lifecycle. Ordered the way work flows, so the list reads as a sequence. */
const ROLES: { value: string; labelKey: TranslationKey }[] = [
  { value: "in_progress", labelKey: "settings.jira.roleInProgress" },
  { value: "in_review", labelKey: "settings.jira.roleInReview" },
  { value: "archived", labelKey: "settings.jira.roleArchived" },
  { value: "todo", labelKey: "settings.jira.roleQueued" },
];

export function BoardColumnSettings() {
  const t = useT();
  const orgOwnedColumns = useOrgFlag("org_board_columns");
  if (!orgOwnedColumns) return null;
  return (
    <SettingsSection
      title={t("settings.boardColumns.title")}
      description={t("settings.boardColumns.description")}
    >
      <SettingsCard>
        <SettingsCardItem
          title={t("settings.boardColumns.fieldLabel")}
          description={t("settings.boardColumns.fieldDescription")}
        >
          <BoardColumnRows />
        </SettingsCardItem>
      </SettingsCard>
    </SettingsSection>
  );
}

function BoardColumnRows() {
  const t = useT();
  const { columns, isLoading } = useTaskBoardItems();
  const { automations, isPending } = useColumnAutomations();

  if (isLoading || isPending) return <Skeleton className="h-32 w-full" />;
  if (columns.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("settings.jira.noColumnsYet")}
      </p>
    );
  }

  const promptOf = new Map(automations.map((a) => [a.columnKey, a.prompt]));

  return (
    <div className="flex w-full flex-col">
      {columns.map((column) => (
        <BoardColumnRow
          key={column.key}
          columnKey={column.key}
          title={column.title}
          role={column.role}
          runsAgent={promptOf.has(column.key)}
          prompt={promptOf.get(column.key) ?? null}
        />
      ))}
    </div>
  );
}

/** `prompt` null with `runsAgent` true means the rule is on with the agent's
 *  own instruction; the column is absent from `automations` when it is off. */
function BoardColumnRow({
  columnKey,
  title,
  role,
  runsAgent,
  prompt,
}: {
  columnKey: string;
  title: string;
  role: string | null;
  runsAgent: boolean;
  prompt: string | null;
}) {
  const t = useT();
  const setRole = useSetColumnRole();
  const setAutomation = useSetColumnAutomation();
  // A draft, so typing is not a write per keystroke. Re-seeded on change.
  const [draft, setDraft] = useState(prompt ?? "");
  const [syncedWith, setSyncedWith] = useState(prompt);
  if (syncedWith !== prompt) {
    setSyncedWith(prompt);
    setDraft(prompt ?? "");
  }

  const saveAutomation = (next: string | null) =>
    setAutomation.mutate(
      { columnKey, prompt: next },
      { onError: () => toast.error(t("settings.boardColumns.saveFailed")) },
    );

  return (
    <div className="flex flex-col gap-2 border-b border-border/60 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        <Select
          value={role ?? NO_ROLE}
          onValueChange={(value) =>
            setRole.mutate(
              { columnKey, role: value === NO_ROLE ? null : value },
              {
                onError: () =>
                  toast.error(t("settings.boardColumns.saveFailed")),
              },
            )
          }
        >
          <SelectTrigger className="w-44 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_ROLE}>
              {t("settings.jira.roleNone")}
            </SelectItem>
            {ROLES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {t(option.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Switch
          checked={runsAgent}
          aria-label={t("settings.boardColumns.toggleAriaLabel", {
            column: title,
          })}
          onCheckedChange={(next) => saveAutomation(next ? draft : null)}
        />
      </div>
      {runsAgent && (
        <Input
          value={draft}
          placeholder={t("settings.boardColumns.promptPlaceholder")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== (prompt ?? "")) saveAutomation(draft);
          }}
          data-column-automation-prompt={columnKey}
        />
      )}
    </div>
  );
}
