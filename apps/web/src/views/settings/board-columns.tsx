/**
 * Settings → Tasks → "Board columns", for every board: Studio's own lanes and
 * the columns an org mirrors from its tracker alike.
 *
 * One card per column, answering the two questions a column raises, in the
 * words of what actually happens rather than in the words of the schema:
 *
 *   "Move cards here when …"   — the column's role, named by the EVENT Studio
 *                                actually detects, not by a paraphrase of it.
 *                                A role is a destination, never a trigger, and
 *                                spelling out the event is what keeps it from
 *                                reading backwards. Where a role has several
 *                                triggers the label names them, because one of
 *                                them alone would be concrete and wrong.
 *   "Run the agent …"          — an automation you add and delete, not a
 *                                switch. Adding it opens the instruction box;
 *                                deleting it is how you turn it off, which is
 *                                also literally what the storage does.
 *
 * Studio's own board shows the same cards WITHOUT the role picker: its
 * lifecycle is decided, and offering that choice per canonical lane would
 * invite a team to turn off what makes the board work. What it does get is the
 * automation and the prompt the automation runs, which belong to every board.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  DEFAULT_TASK_INITIAL_PROMPT,
  TASK_INITIAL_PROMPT_VARS,
} from "@decocms/shared/task-initial-prompt";
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
import { laneHeader } from "@/layouts/task-board/config";

/** Nothing moves a card here on its own. */
const NO_TRIGGER = "__none__";

/** Each role, named by the moment Studio detects. Ordered the way work flows,
 *  so the list reads as a sequence. */
const TRIGGERS: { value: string; labelKey: TranslationKey }[] = [
  { value: "in_progress", labelKey: "settings.boardColumns.whenRunStarts" },
  { value: "in_review", labelKey: "settings.boardColumns.whenRunFinishes" },
  { value: "archived", labelKey: "settings.boardColumns.whenMergedAndSettled" },
  { value: "todo", labelKey: "settings.boardColumns.whenRunFailsOut" },
];

export function BoardColumnSettings() {
  const t = useT();
  // Only a tracker's columns need saying what they mean.
  const orgOwnedColumns = useOrgFlag("org_board_columns");
  return (
    <SettingsSection
      title={t("settings.boardColumns.title")}
      description={t(
        orgOwnedColumns
          ? "settings.boardColumns.description"
          : "settings.boardColumns.descriptionStudioBoard",
      )}
    >
      <SettingsCard>
        <SettingsCardItem
          title={t("settings.boardColumns.fieldLabel")}
          description={t(
            orgOwnedColumns
              ? "settings.boardColumns.fieldDescription"
              : "settings.boardColumns.fieldDescriptionStudioBoard",
          )}
        >
          <BoardColumnRows showRole={orgOwnedColumns} />
        </SettingsCardItem>
      </SettingsCard>
    </SettingsSection>
  );
}

function BoardColumnRows({ showRole }: { showRole: boolean }) {
  const t = useT();
  const { columns, isLoading } = useTaskBoardItems();
  const { automations, isPending } = useColumnAutomations();

  if (isLoading || isPending) return <Skeleton className="h-40 w-full" />;
  if (columns.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("settings.jira.noColumnsYet")}
      </p>
    );
  }

  const promptOf = new Map(automations.map((a) => [a.columnKey, a.prompt]));

  return (
    <div className="flex w-full flex-col gap-3">
      {columns.map((column) => (
        <BoardColumnCard
          key={column.key}
          columnKey={column.key}
          title={laneHeader(column.key, t, columns).label}
          showRole={showRole}
          trigger={column.role}
          hasAutomation={promptOf.has(column.key)}
          prompt={promptOf.get(column.key) ?? null}
        />
      ))}
    </div>
  );
}

/** `prompt` null with `hasAutomation` true means the rule runs on the shipped
 *  default prompt; the column is absent from `automations` when there is no
 *  rule at all. */
function BoardColumnCard({
  columnKey,
  title,
  showRole,
  trigger,
  hasAutomation,
  prompt,
}: {
  columnKey: string;
  title: string;
  showRole: boolean;
  trigger: string | null;
  hasAutomation: boolean;
  prompt: string | null;
}) {
  const t = useT();
  const setRole = useSetColumnRole();
  const setAutomation = useSetColumnAutomation();
  // An unset rule runs the shipped default, so that is what the box shows —
  // otherwise "what does this column actually send?" is unanswerable from here,
  // and editing it means retyping a prompt you can't see.
  const saved = prompt ?? DEFAULT_TASK_INITIAL_PROMPT;
  // A draft, so typing is not a write per keystroke. Re-seeded on change.
  const [draft, setDraft] = useState(saved);
  const [syncedWith, setSyncedWith] = useState(saved);
  if (syncedWith !== saved) {
    setSyncedWith(saved);
    setDraft(saved);
  }

  const failed = () => toast.error(t("settings.boardColumns.saveFailed"));
  const saveAutomation = (next: string | null) =>
    setAutomation.mutate({ columnKey, prompt: next }, { onError: failed });

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <span className="truncate text-sm font-medium">{title}</span>

      {showRole && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t("settings.boardColumns.moveHereWhen")}
          </span>
          <Select
            value={trigger ?? NO_TRIGGER}
            onValueChange={(value) =>
              setRole.mutate(
                { columnKey, role: value === NO_TRIGGER ? null : value },
                { onError: failed },
              )
            }
          >
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_TRIGGER}>
                {t("settings.boardColumns.whenNever")}
              </SelectItem>
              {TRIGGERS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {hasAutomation ? (
        <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">
              {t("settings.boardColumns.automationOn")}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("settings.boardColumns.removeAriaLabel", {
                column: title,
              })}
              onClick={() => saveAutomation(null)}
            >
              <Trash01 size={14} />
            </Button>
          </div>
          <Textarea
            value={draft}
            rows={10}
            className="font-mono text-xs"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft !== saved) saveAutomation(draft);
            }}
            data-column-automation-prompt={columnKey}
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.boardColumns.promptHelp")}
          </p>
          <ul className="flex flex-col gap-0.5">
            {Object.entries(TASK_INITIAL_PROMPT_VARS).map(([name, help]) => (
              <li
                key={name}
                className="flex gap-2 text-xs text-muted-foreground"
              >
                <code className="shrink-0 font-mono text-foreground">
                  {`{{${name}}}`}
                </code>
                <span>{help}</span>
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            // Resetting a stored override is a write (back to null); resetting
            // an unsaved edit is just discarding it.
            disabled={prompt === null && draft === saved}
            onClick={() => {
              setDraft(DEFAULT_TASK_INITIAL_PROMPT);
              if (prompt !== null) saveAutomation("");
            }}
          >
            {t("settings.boardColumns.promptReset")}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => saveAutomation("")}
        >
          <Plus size={14} />
          {t("settings.boardColumns.addAutomation")}
        </Button>
      )}
    </div>
  );
}
