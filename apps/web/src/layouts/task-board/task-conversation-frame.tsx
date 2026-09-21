import { useState, type ReactNode } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t";
import { useTaskBoardComments } from "@/hooks/use-task-board-comments";
import { toast } from "sonner";
import type { TaskBoardItem } from "./config";
import { NewCommentComposer } from "./task-comments";

/** Owns conversation scrolling; the composer stays visible beside the inspector. */
export function TaskConversationFrame({
  item,
  enabled,
  hidden,
  children,
}: {
  item?: TaskBoardItem;
  enabled: boolean;
  hidden: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const stick = useStickToBottom({ initial: false, resize: "instant" });
  const comments = useTaskBoardComments(item?.id);
  const [seenIds, setSeenIds] = useState<string[] | null>(null);
  const messageIds = comments.threads.flatMap((thread) => [
    thread.id,
    ...thread.replies.map((reply) => reply.id),
  ]);
  if (
    !comments.isLoading &&
    (seenIds === null || stick.isAtBottom) &&
    messageIds.join() !== seenIds?.join()
  ) {
    setSeenIds(messageIds);
  }
  const unreadCount = seenIds
    ? messageIds.filter((id) => !seenIds.includes(id)).length
    : 0;

  if (!item || !enabled)
    return <div className="min-w-0 sm:flex-1">{children}</div>;

  return (
    <div
      className={cn(
        "relative min-h-0 min-w-0 flex-1 flex-col",
        hidden ? "hidden lg:flex" : "flex",
      )}
    >
      <div
        data-testid="task-conversation-scroll"
        ref={stick.scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div ref={stick.contentRef}>{children}</div>
      </div>
      {item && (
        <div className="relative shrink-0 border-t border-border bg-background px-5 pb-4 pt-3 sm:px-8">
          {!stick.isAtBottom && (
            <div className="absolute inset-x-0 bottom-full flex justify-center pb-3 pointer-events-none">
              <Button
                variant="secondary"
                size="sm"
                className="pointer-events-auto rounded-full border border-border shadow-md"
                onClick={() => void stick.scrollToBottom()}
              >
                {unreadCount
                  ? t("taskBoard.conversation.newReplies", {
                      count: unreadCount,
                    })
                  : t("taskBoard.conversation.jumpToLatest")}
              </Button>
            </div>
          )}
          <NewCommentComposer
            onSubmit={async (body) => {
              try {
                await comments.post.mutateAsync({ body });
                void stick.scrollToBottom();
                return true;
              } catch (error) {
                toast.error(
                  error instanceof Error
                    ? error.message
                    : t("taskBoard.conversation.sendFailed"),
                );
                return false;
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
