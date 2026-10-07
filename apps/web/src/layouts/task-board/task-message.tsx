import type { ReactNode } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { MemoizedMarkdown } from "@/components/chat/markdown";
import { formatTimeAgo } from "@/lib/format-time";
import { useT } from "@/i18n/use-t";

/** Shared presentation for human comments, agent reports, and linked runs. */
export function TaskMessage({
  id,
  author,
  avatar,
  createdAt,
  body,
  metadata,
  actions,
  onOpenThread,
  isReply,
  commentId,
  muted,
}: {
  id: string;
  author: string;
  avatar: ReactNode;
  createdAt: string;
  body: string;
  metadata?: ReactNode;
  actions?: ReactNode;
  onOpenThread?: () => void;
  isReply?: boolean;
  commentId?: string;
  /** Agent handoff, shown only behind the scenes: dimmed so the messages
   *  written for people stand out. */
  muted?: boolean;
}) {
  const t = useT();
  return (
    <article
      data-comment-id={commentId}
      data-testid="task-message"
      data-muted={muted || undefined}
      className={cn(
        "group flex min-w-0 flex-col gap-1.5 py-3",
        muted && "opacity-60 transition-opacity hover:opacity-100",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {avatar}
        <span className="text-sm font-medium text-foreground">{author}</span>
        <time dateTime={createdAt} className="text-sm text-muted-foreground">
          {formatTimeAgo(new Date(createdAt))}
        </time>
        {muted && (
          <span className="text-xs text-muted-foreground">
            {t("taskBoard.conversation.behindTheScenesLabel")}
          </span>
        )}
        {metadata}
        <div className="ml-auto flex items-center gap-1">
          {onOpenThread && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              onClick={onOpenThread}
            >
              {t("taskBoard.conversation.openChat")}
            </Button>
          )}
          {actions}
        </div>
      </div>
      {body && (
        <div
          className={cn(
            "min-w-0 break-words pl-8 text-sm leading-relaxed text-foreground [&_li]:text-sm [&_p]:text-sm",
            // A thumbnail: a tall screenshot would take over the conversation, and a click opens it whole.
            "[&_img]:max-h-80",
            isReply && "ml-3 border-l border-border pl-5",
          )}
        >
          <MemoizedMarkdown id={id} text={body} imageGallery />
        </div>
      )}
    </article>
  );
}
