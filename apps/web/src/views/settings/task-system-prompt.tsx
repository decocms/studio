/**
 * Settings → Tasks → "System prompt" — free-text house rules appended to the
 * system prompt of every agent run dispatched from a board card (the Super
 * Agent's and the reviewer's alike). Org-scoped, so it applies to every
 * member's cards.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { TASK_SYSTEM_PROMPT_MAX_LENGTH } from "@decocms/shared/task-board";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import {
  useOrgTaskBoardPrompt,
  useSetOrgTaskBoardPrompt,
} from "@/hooks/use-task-board-prompts";
import { useT } from "@/i18n/use-t.ts";

export function TaskSystemPromptSettings() {
  const t = useT();
  const { prompt, isPending } = useOrgTaskBoardPrompt();
  const save = useSetOrgTaskBoardPrompt();

  // Local draft so typing isn't a write per keystroke. Re-seeded whenever the
  // saved value changes underneath (another member's edit, the first load) —
  // without that the textarea would keep rendering the pre-load empty string.
  const [draft, setDraft] = useState(prompt);
  const [syncedWith, setSyncedWith] = useState(prompt);
  if (syncedWith !== prompt) {
    setSyncedWith(prompt);
    setDraft(prompt);
  }

  return (
    <SettingsSection title={t("settings.taskPrompt.title")}>
      <SettingsCard>
        <SettingsCardItem title={t("settings.taskPrompt.fieldLabel")}>
          {isPending ? (
            <Skeleton className="h-44 w-full" />
          ) : (
            <div className="flex flex-col items-start gap-2">
              <Textarea
                value={draft}
                rows={10}
                maxLength={TASK_SYSTEM_PROMPT_MAX_LENGTH}
                placeholder={t("settings.taskPrompt.placeholder")}
                onChange={(e) => setDraft(e.target.value)}
              />
              <Button
                size="sm"
                disabled={draft === prompt || save.isPending}
                onClick={() =>
                  save.mutate(draft, {
                    onSuccess: () =>
                      toast.success(t("settings.taskPrompt.saved")),
                    onError: () => toast.error(t("settings.taskPrompt.failed")),
                  })
                }
              >
                {t("settings.taskPrompt.save")}
              </Button>
            </div>
          )}
        </SettingsCardItem>
      </SettingsCard>
    </SettingsSection>
  );
}
