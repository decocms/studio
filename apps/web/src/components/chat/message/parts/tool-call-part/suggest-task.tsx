"use client";

import { cn } from "@decocms/ui/lib/utils.ts";
import { ClipboardCheck } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import type { SuggestTaskToolPart } from "../../../types.ts";

/**
 * Transcript trace for a resolved `suggest_task` offer — the live card lives
 * above the chat input (`SuggestTaskHighlight`). Renders nothing while pending
 * so the offer isn't shown twice.
 */
export function SuggestTaskPart({ part }: { part: SuggestTaskToolPart }) {
  const t = useT();
  if (!part.state.startsWith("output-")) return null;

  const accepted = part.output?.accepted === true;

  return (
    <div className="my-1.5 flex items-start gap-2">
      <ClipboardCheck className="size-4 text-muted-foreground/50 shrink-0 mt-0.5" />
      <span className="text-[14px] leading-snug text-muted-foreground">
        {part.input?.title}
      </span>
      <span
        className={cn(
          "text-[14px] leading-snug shrink-0",
          accepted ? "text-foreground/70" : "text-muted-foreground/50 italic",
        )}
      >
        {accepted
          ? t("chat.suggestTask.accepted")
          : t("chat.suggestTask.declined")}
      </span>
    </div>
  );
}
