import { useState, type ReactNode } from "react";
import { useCopy } from "@decocms/ui/hooks/use-copy.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import { MemoizedMarkdown } from "../../markdown.tsx";
import { Check, Copy01 } from "@untitledui/icons";
import type { TextUIPart } from "ai";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

interface MessageTextPartProps {
  id: string;
  part: TextUIPart;
  copyable?: boolean;
  extraActions?: ReactNode;
  /** When true, actions row is always visible instead of hover-only */
  alwaysShowActions?: boolean;
  /** Fade newly streamed words in — true only while the last message streams. */
  animate?: boolean;
}

export function MessageTextPart({
  id,
  part,
  copyable = false,
  extraActions,
  alwaysShowActions = false,
  animate = false,
}: MessageTextPartProps) {
  const { handleCopy } = useCopy();
  const t = useT();
  const [isCopied, setIsCopied] = useState(false);

  const handleCopyMessage = async () => {
    track("chat_message_copied", {
      message_id: id,
      chars: part.text.length,
    });
    await handleCopy(part.text);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  // Only show copy button on the last part (the one with extraActions/usage stats)
  const showCopyButton = copyable && extraActions;
  const showActions = showCopyButton || extraActions;

  return (
    <div className="group/part relative">
      <MemoizedMarkdown id={id} text={part.text} animate={animate} />
      {showActions && (
        <div
          className={cn(
            "flex w-full items-center gap-2 text-sm text-muted-foreground transition-all duration-200 mt-1 py-1",
            alwaysShowActions
              ? "opacity-100"
              : "opacity-0 pointer-events-none group-hover/part:opacity-100 group-hover/part:pointer-events-auto",
          )}
        >
          {extraActions}
          {showCopyButton && extraActions && (
            <span className="text-muted-foreground/40 select-none">·</span>
          )}
          {showCopyButton && (
            <button
              type="button"
              onClick={handleCopyMessage}
              className="text-muted-foreground [@media(hover:hover)]:hover:text-foreground transition-colors active:scale-[0.97]"
              aria-label={t("chat.textPart.copyMessage")}
            >
              {isCopied ? (
                <Check className="size-4" />
              ) : (
                <Copy01 className="size-4" />
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
