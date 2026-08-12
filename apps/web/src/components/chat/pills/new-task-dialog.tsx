/**
 * "New task" entry for the task-based flow (opened from the task pill). Ask what
 * to do: describe it and the agent runs it on a fresh task, or edit the site by
 * hand in a new CMS environment. Presentational — the caller owns both actions.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Edit05, Lightning01 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";

export function NewTaskDialog({
  open,
  onClose,
  onSubmitPrompt,
  onEditManually,
  isSubmitting,
}: {
  open: boolean;
  onClose: () => void;
  /** Describe → run on the agent. Receives the trimmed prompt. */
  onSubmitPrompt: (text: string) => void;
  /** New CMS environment to edit by hand. */
  onEditManually: () => void;
  isSubmitting?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState("");

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmitPrompt(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex flex-col gap-6 rounded-2xl p-8 sm:max-w-lg">
        <DialogTitle className="text-xl font-medium text-foreground">
          {t("chat.newTask.heading")}
        </DialogTitle>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter submits; a plain Enter keeps adding lines.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t("chat.newTask.placeholder")}
          autoFocus
          rows={5}
          className="w-full resize-none rounded-xl border border-border bg-background p-4 text-sm text-foreground outline-none transition-colors placeholder:text-foreground/30 focus:border-foreground/30"
        />

        <Button
          size="lg"
          disabled={!text.trim() || isSubmitting}
          onClick={submit}
        >
          <Lightning01 size={16} />
          {t("chat.newTask.submit")}
        </Button>

        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          {t("chat.newTask.orDivider")}
          <span className="h-px flex-1 bg-border" />
        </div>

        <Button
          variant="outline"
          size="lg"
          disabled={isSubmitting}
          onClick={onEditManually}
        >
          <Edit05 size={16} />
          {t("chat.newTask.editManually")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
