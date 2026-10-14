/** Settings → Tasks → "System prompt": org-wide instructions and skills for every card run. */

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
  useSaveColumnRules,
  useTaskBoardPrompts,
} from "@/hooks/use-task-board-prompts";
import { SkillsField } from "@/layouts/task-board/column-rules";
import { useT } from "@/i18n/use-t.ts";

export function TaskSystemPromptSettings() {
  const t = useT();
  const { data, isPending } = useTaskBoardPrompts();
  const save = useSaveColumnRules();
  const saved = data?.find((p) => p.columnKey === null);
  const prompt = saved?.prompt ?? "";
  const skills = saved?.skills ?? [];

  // Local draft so typing isn't a write per keystroke. Re-seeded whenever the
  // saved value changes underneath (another member's edit, the first load) —
  // without that the textarea would keep rendering the pre-load empty string.
  const [draft, setDraft] = useState({ prompt, skills });
  const [syncedWith, setSyncedWith] = useState(saved);
  if (syncedWith !== saved) {
    setSyncedWith(saved);
    setDraft({ prompt, skills });
  }
  const dirty =
    draft.prompt !== prompt || draft.skills.join("\n") !== skills.join("\n");

  return (
    <SettingsSection title={t("settings.taskPrompt.title")}>
      <SettingsCard>
        <SettingsCardItem title={t("settings.taskPrompt.fieldLabel")}>
          {isPending ? (
            <Skeleton className="h-44 w-full" />
          ) : (
            <div className="flex flex-col items-start gap-3">
              <Textarea
                value={draft.prompt}
                rows={10}
                maxLength={TASK_SYSTEM_PROMPT_MAX_LENGTH}
                placeholder={t("settings.taskPrompt.placeholder")}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              />
              <div className="flex w-full flex-col gap-2">
                <span className="text-sm font-medium text-foreground">
                  {t("settings.taskPrompt.skillsLabel")}
                </span>
                <SkillsField
                  value={draft.skills}
                  onChange={(next) => setDraft({ ...draft, skills: next })}
                />
              </div>
              <Button
                size="sm"
                disabled={!dirty || save.isPending}
                onClick={() =>
                  save.mutate(
                    { columnKey: null, rules: draft },
                    {
                      onSuccess: () =>
                        toast.success(t("settings.taskPrompt.saved")),
                      onError: () =>
                        toast.error(t("settings.taskPrompt.failed")),
                    },
                  )
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
