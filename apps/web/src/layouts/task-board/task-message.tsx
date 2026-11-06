import type { MouseEvent, ReactNode } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { MemoizedMarkdown } from "@/components/chat/markdown";
import { formatTimeAgo } from "@/lib/format-time";
import { useT } from "@/i18n/use-t";

const CLOCK_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const FULL_DATE_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "short",
});

/** A row click that opens the chat, unless it landed on a control or ended a text selection. */
export function openOnRowClick(onOpen: () => void) {
  return (event: MouseEvent) => {
    if (
      event.target instanceof Element &&
      event.target.closest("a, button, input, [contenteditable=true]")
    )
      return;
    if (window.getSelection()?.toString()) return;
    onOpen();
  };
}

/**
 * One chat line, shared by human comments, agent reports, and linked runs:
 * avatar in a gutter, name and time on one line, the body under the name.
 * The row lights up on hover and its actions float over its top-right corner,
 * so a quiet conversation carries no chrome.
 */
export function TaskMessage({
  id,
  author,
  avatar,
  createdAt,
  body,
  metadata,
  actions,
  onOpenThread,
  onOpen,
  commentId,
  muted,
  editor,
  continuation,
}: {
  id: string;
  author: string;
  avatar: ReactNode;
  createdAt: string;
  body: string;
  metadata?: ReactNode;
  /** Floating toolbar content, shown while the row is hovered or focused. */
  actions?: ReactNode;
  onOpenThread?: () => void;
  /** Makes the whole row open the chat; its buttons and links keep their own clicks. */
  onOpen?: () => void;
  commentId?: string;
  /** Agent handoff, shown only behind the scenes: dimmed so the messages
   *  written for people stand out. */
  muted?: boolean;
  /** Takes the body's place while the message is being edited. */
  editor?: ReactNode;
  /** Same author right after their previous message: no avatar or name, the
   *  clock time sits in the gutter on hover. */
  continuation?: boolean;
}) {
  const t = useT();
  const date = new Date(createdAt);
  const fullDate = FULL_DATE_FMT.format(date);
  return (
    <article
      data-comment-id={commentId}
      data-testid="task-message"
      data-muted={muted || undefined}
      onClick={onOpen && openOnRowClick(onOpen)}
      className={cn(
        "group relative -mx-3 flex min-w-0 gap-3 rounded-lg px-3 transition-colors hover:bg-muted/50",
        continuation ? "py-1" : "py-2.5",
        muted && "opacity-60 hover:opacity-100",
        onOpen && "cursor-pointer",
      )}
    >
      <div className="flex w-8 shrink-0 justify-center">
        {continuation ? (
          <time
            dateTime={createdAt}
            title={fullDate}
            className="text-meta whitespace-nowrap pt-0.5 opacity-0 group-hover:opacity-100"
          >
            {CLOCK_FMT.format(date)}
          </time>
        ) : (
          <div className="pt-0.5">{avatar}</div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {(!continuation || metadata || onOpenThread) && (
          <div className="flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1">
            {!continuation && (
              <>
                <span className="text-sm font-medium text-foreground">
                  {author}
                </span>
                <time
                  dateTime={createdAt}
                  title={fullDate}
                  className="text-meta"
                >
                  {formatTimeAgo(date)}
                </time>
              </>
            )}
            {muted && (
              <span className="text-meta">
                {t("taskBoard.conversation.behindTheScenesLabel")}
              </span>
            )}
            {metadata}
            {onOpenThread && (
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto font-normal text-muted-foreground"
                onClick={onOpenThread}
              >
                {t("taskBoard.conversation.openChat")}
              </Button>
            )}
          </div>
        )}
        {(editor || body) && (
          <div
            className={cn(
              "min-w-0 break-words leading-relaxed text-foreground",
              // A thumbnail: a tall screenshot would take over the conversation, and a click opens it whole.
              "[&_img]:max-h-80",
            )}
          >
            {editor ?? <MemoizedMarkdown id={id} text={body} imageGallery />}
          </div>
        )}
      </div>
      {actions && (
        <div className="surface absolute -top-3 right-3 z-10 flex items-center gap-0.5 rounded-lg p-0.5 opacity-0 transition-opacity group-hover:opacity-100 has-[:focus-visible]:opacity-100 has-[[data-state=open]]:opacity-100">
          {actions}
        </div>
      )}
    </article>
  );
}
