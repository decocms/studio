import type { StudioToolInput } from "@decocms/shared/tools/tool-io";
import { Button } from "@decocms/ui/components/button.tsx";
import { useT } from "@/i18n/use-t";
import { createContext, useContext, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";

export const FirstUnreadCommentContext = createContext<string | null>(null);
export function useFirstUnreadCommentId() {
  return useContext(FirstUnreadCommentContext);
}

/** Reading to the bottom acknowledges this snapshot, not comments arriving
 * while the request is in flight. Background tabs never advance the marker. */
export function ConversationReadMarker({
  itemId,
  throughCommentId,
  notificationIds,
  unreadCount,
}: {
  itemId: string;
  throughCommentId: string | null;
  notificationIds: string[];
  unreadCount: number;
}) {
  const submitted = useRef<string | null>(null);
  const snapshot = JSON.stringify([itemId, throughCommentId, notificationIds]);
  const studio = useStudioTools();
  const t = useT();
  const input = { taskBoardItemId: itemId, throughCommentId, notificationIds };
  const { locator } = useProjectContext();
  const queryClient = useQueryClient();
  const mark = useMutation({
    mutationFn: (
      snapshot: StudioToolInput<"TASK_BOARD_CONVERSATION_MARK_READ">,
    ) => studio.call("TASK_BOARD_CONVERSATION_MARK_READ", snapshot),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardComments(locator, itemId),
      });
      void queryClient.invalidateQueries({
        queryKey: KEYS.notifications(locator),
      });
      void queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardForum(locator),
        refetchType: "all",
      });
    },
  });
  if (!unreadCount && !notificationIds.length) return null;
  if (mark.isError)
    return (
      <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
        <span>{t("taskBoard.forum.markReadFailed")}</span>
        <Button variant="ghost" size="sm" onClick={() => mark.mutate(input)}>
          {t("taskBoard.forum.retry")}
        </Button>
      </div>
    );
  return (
    <div
      className="h-px shrink-0"
      aria-hidden
      ref={(node) => {
        if (!node) return;
        let visible = false;
        const acknowledge = () => {
          if (
            !visible ||
            submitted.current === snapshot ||
            document.visibilityState !== "visible"
          )
            return;
          submitted.current = snapshot;
          mark.mutate(input);
        };
        const observer = new IntersectionObserver((entries) => {
          visible = entries.some((entry) => entry.isIntersecting);
          acknowledge();
        });
        observer.observe(node);
        document.addEventListener("visibilitychange", acknowledge);
        return () => {
          observer.disconnect();
          document.removeEventListener("visibilitychange", acknowledge);
        };
      }}
    />
  );
}
