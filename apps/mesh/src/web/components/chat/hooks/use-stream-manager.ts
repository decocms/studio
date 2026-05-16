/**
 * useStreamManager — task-scoped SSE cache invalidations for messages.
 *
 * Thread-list cache patching now lives in <ThreadEventsBridge>.
 * Thread-outputs invalidation runs in useThreadChat.onFinish (chat-context),
 * gated on whether the turn called `share_with_user`.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useDecopilotEvents } from "../../../hooks/use-decopilot-events";

export function useStreamManager(threadId: string): void {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();

  const invalidateMessages = () => {
    if (!threadId) return;
    queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        if (key[3] !== "collection" || key[4] !== "THREAD_MESSAGES")
          return false;
        const serialized = typeof key[6] === "string" ? key[6] : "";
        return serialized.includes(threadId);
      },
    });
  };

  useDecopilotEvents({
    orgSlug: org.slug,
    taskId: threadId,
    onFinish: () => {
      invalidateMessages();
    },
    onTaskStatus: (event) => {
      if (event.data.status === "in_progress") {
        invalidateMessages();
      }
    },
  });
}
