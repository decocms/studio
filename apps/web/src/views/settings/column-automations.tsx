/**
 * Settings → Tasks → "When a card lands in a column".
 *
 * One row per column of the board, each a switch and an optional instruction.
 * Turning a column on means the agent picks up every card that arrives there —
 * whether the tracker's sync moved it or a person dragged it.
 *
 * Shown only for a board whose columns are the org's own. On Studio's board
 * the lifecycle is already decided, so there is nothing here to choose; a
 * switch per canonical lane would invite a team to turn off the thing that
 * makes the board work.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Input } from "@decocms/ui/components/input.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useOrgFlag } from "@/hooks/use-organization-settings";
import { useTaskBoardItems } from "@/hooks/use-task-board-items";
import {
  useColumnAutomations,
  useSetColumnAutomation,
} from "@/hooks/use-column-automations";
import { useT } from "@/i18n/use-t.ts";

export function ColumnAutomationSettings() {
  const t = useT();
  const orgOwnedColumns = useOrgFlag("org_board_columns");
  if (!orgOwnedColumns) return null;
  return (
    <SettingsSection
      title={t("settings.columnAutomations.title")}
      description={t("settings.columnAutomations.description")}
    >
      <SettingsCard>
        <SettingsCardItem
          title={t("settings.columnAutomations.fieldLabel")}
          description={t("settings.columnAutomations.fieldDescription")}
        >
          <ColumnAutomationRows />
        </SettingsCardItem>
      </SettingsCard>
    </SettingsSection>
  );
}

function ColumnAutomationRows() {
  const t = useT();
  const { columns, isLoading } = useTaskBoardItems();
  const { automations, isPending } = useColumnAutomations();
  const save = useSetColumnAutomation();

  if (isLoading || isPending) return <Skeleton className="h-24 w-full" />;
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
        <ColumnAutomationRow
          key={column.key}
          columnKey={column.key}
          title={column.title}
          on={promptOf.has(column.key)}
          prompt={promptOf.get(column.key) ?? null}
          onSave={(prompt) =>
            save.mutate(
              { columnKey: column.key, prompt },
              {
                onError: () =>
                  toast.error(t("settings.columnAutomations.saveFailed")),
              },
            )
          }
        />
      ))}
    </div>
  );
}

/** One column's rule. `prompt` null means the rule is on with the agent's own
 *  instruction; the row is absent from `automations` when it is off. */
function ColumnAutomationRow({
  columnKey,
  title,
  on,
  prompt,
  onSave,
}: {
  columnKey: string;
  title: string;
  on: boolean;
  prompt: string | null;
  onSave: (prompt: string | null) => void;
}) {
  const t = useT();
  // A draft, so typing is not a write per keystroke. Re-seeded on change.
  const [draft, setDraft] = useState(prompt ?? "");
  const [syncedWith, setSyncedWith] = useState(prompt);
  if (syncedWith !== prompt) {
    setSyncedWith(prompt);
    setDraft(prompt ?? "");
  }

  return (
    <div className="flex flex-col gap-2 border-b border-border/60 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-4">
        <span className="min-w-0 truncate text-sm">{title}</span>
        <Switch
          checked={on}
          aria-label={t("settings.columnAutomations.toggleAriaLabel", {
            column: title,
          })}
          onCheckedChange={(next) => onSave(next ? draft : null)}
        />
      </div>
      {on && (
        <Input
          value={draft}
          placeholder={t("settings.columnAutomations.promptPlaceholder")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== (prompt ?? "")) onSave(draft);
          }}
          data-column-automation-prompt={columnKey}
        />
      )}
    </div>
  );
}
