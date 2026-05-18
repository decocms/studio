/**
 * useStreamManager — task-scoped SSE cache invalidations for messages.
 *
 * Thread-list cache patching now lives in <ThreadEventsBridge>.
 * Thread-outputs invalidation runs in useChatThread.onFinish (chat-context),
 * gated on whether the turn called `share_with_user`.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useDecopilotEvents } from "../../../hooks/use-decopilot-events";
import { invalidateThreadMessages } from "../task/invalidate-thread-messages";

export function useStreamManager(threadId: string): void {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();

  useDecopilotEvents({
    orgSlug: org.slug,
    taskId: threadId,
    onFinish: () => {
      if (threadId) invalidateThreadMessages(queryClient, threadId);
    },
    onTaskStatus: (event) => {
      if (event.data.status === "in_progress" && threadId)
        invalidateThreadMessages(queryClient, threadId);
    },
  });
}
