"use client";

import { cn } from "@deco/ui/lib/utils.ts";
import { MessageQuestionCircle } from "@untitledui/icons";
import type { UserAskToolPart } from "../../../types.ts";
import { getToolPartErrorText } from "../utils.ts";

interface UserAskPartProps {
  part: UserAskToolPart;
  /** Latency in seconds from data-tool-metadata part (unused here) */
  latency?: number;
}

export function UserAskPart({ part }: UserAskPartProps) {
  // Only render after user has responded
  if (!part.state.startsWith("output-")) {
    return null;
  }

  const question = part.input?.prompt?.trim() || "Question";
  const isError =
    part.state === "output-error" || part.state === "output-denied";
  const isDenied = part.state === "output-denied";

  const answer: string = isDenied
    ? "Skipped"
    : part.state === "output-error"
      ? (getToolPartErrorText(part) ?? "Error")
      : (part.output?.response ?? "");

  return (
    <div className="my-1.5 flex flex-col gap-1">
      {/* Question row */}
      <div className="flex items-start gap-2">
        <MessageQuestionCircle className="size-4 text-muted-foreground/50 shrink-0 mt-0.5" />
        <span className="text-[14px] text-muted-foreground leading-snug">
          {question}
        </span>
      </div>

      {/* Answer row */}
      {answer && (
        <div className="ml-6 pl-2 border-l border-border/50">
          <span
            className={cn(
              "text-[14px] leading-snug",
              isError
                ? "text-muted-foreground/50 italic"
                : "text-foreground/70",
            )}
          >
            {answer}
          </span>
        </div>
      )}
    </div>
  );
}
