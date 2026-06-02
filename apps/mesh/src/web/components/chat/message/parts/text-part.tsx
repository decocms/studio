import { useState, type ReactNode } from "react";
import { useCopy } from "@deco/ui/hooks/use-copy.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import { MemoizedMarkdown } from "../../markdown.tsx";
import { Check, Copy01, ThumbsDown, ThumbsUp } from "@untitledui/icons";
import type { TextUIPart } from "ai";
import { track, getSessionReplayUrl } from "@/web/lib/posthog-client";
import { useOptionalChatTask } from "../../context.tsx";
import { MessageFeedbackDialog } from "../../message-feedback-dialog.tsx";

interface MessageTextPartProps {
  id: string;
  part: TextUIPart;
  copyable?: boolean;
  extraActions?: ReactNode;
  /** When true, actions row is always visible instead of hover-only */
  alwaysShowActions?: boolean;
}

export function MessageTextPart({
  id,
  part,
  copyable = false,
  extraActions,
  alwaysShowActions = false,
}: MessageTextPartProps) {
  const { handleCopy } = useCopy();
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const [isCopied, setIsCopied] = useState(false);
  const [feedback, setFeedback] = useState<"positive" | null>(null);
  const [negativeOpen, setNegativeOpen] = useState(false);

  const handleCopyMessage = async () => {
    track("chat_message_copied", {
      message_id: id,
      chars: part.text.length,
    });
    await handleCopy(part.text);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleThumbsUp = () => {
    if (feedback === "positive") {
      setFeedback(null);
      track("chat_message_feedback_positive_undone", {
        message_id: id,
        thread_id: threadId,
        session_replay_url: getSessionReplayUrl(),
      });
    } else {
      setFeedback("positive");
      track("chat_message_feedback_positive", {
        message_id: id,
        thread_id: threadId,
        session_replay_url: getSessionReplayUrl(),
      });
    }
  };

  const handleThumbsDown = () => {
    setNegativeOpen(true);
  };

  // Only show copy/feedback on the last part (the one with extraActions/usage stats)
  const showCopyButton = copyable && !!extraActions;
  const showActions = showCopyButton || extraActions;

  return (
    <div className="group/part relative">
      <MemoizedMarkdown id={id} text={part.text} />
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
              aria-label="Copy message"
            >
              {isCopied ? (
                <Check className="size-4" />
              ) : (
                <Copy01 className="size-4" />
              )}
            </button>
          )}
          {showCopyButton && (
            <>
              <span className="text-muted-foreground/40 select-none">·</span>
              <button
                type="button"
                onClick={handleThumbsUp}
                className={cn(
                  "transition-colors active:scale-[0.97]",
                  feedback === "positive"
                    ? "text-foreground"
                    : "text-muted-foreground [@media(hover:hover)]:hover:text-foreground",
                )}
                aria-label="Good response"
              >
                <ThumbsUp
                  className={cn(
                    "size-4",
                    feedback === "positive" && "fill-current",
                  )}
                />
              </button>
              {feedback !== "positive" && (
                <button
                  type="button"
                  onClick={handleThumbsDown}
                  className="text-muted-foreground [@media(hover:hover)]:hover:text-foreground transition-colors active:scale-[0.97]"
                  aria-label="Bad response"
                >
                  <ThumbsDown className="size-4" />
                </button>
              )}
            </>
          )}
        </div>
      )}
      <MessageFeedbackDialog
        open={negativeOpen}
        onOpenChange={setNegativeOpen}
        messageId={id}
        threadId={threadId}
      />
    </div>
  );
}
