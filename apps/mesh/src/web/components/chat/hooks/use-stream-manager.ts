/**
 * useStreamManager — task-scoped SSE cache invalidations.
 *
 * Subscribe model: the persistent /attach connection lives inside
 * useThreadChat and survives across runs, so this hook no longer owns any
 * resume gymnastics. The decopilot org-wide SSE still drives cache
 * invalidations — thread list (titles, status), messages (after a run
 * completes), and download chips (share_with_user output files).
 */

import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useDecopilotEvents } from "../../../hooks/use-decopilot-events";
import { KEYS } from "../../../lib/query-keys";

export function useStreamManager(threadId: string): void {
  const { locator, org } = useProjectContext();
  const queryClient = useQueryClient();

  const invalidateThreadList = () => {
    queryClient.invalidateQueries({ queryKey: KEYS.tasksPrefix(locator) });
  };

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

  const invalidateThreadOutputs = () => {
    if (!threadId) return;
    queryClient.invalidateQueries({
      queryKey: KEYS.threadOutputs(threadId),
    });
  };

  useDecopilotEvents({
    orgSlug: org.slug,
    taskId: threadId,
    onFinish: () => {
      // Backend saves messages before emitting the `decopilot.finish` SSE
      // event, so the DB has the final assistant message by the time this
      // fires. No delay needed.
      invalidateThreadOutputs();
      invalidateThreadList();
      invalidateMessages();
    },
    onTaskStatus: (event) => {
      invalidateThreadList();
      // Cross-tab UX: when another tab starts a run, the sender's
      // optimistic user message isn't in our local state — refetch
      // THREAD_MESSAGES so the new user-row from the DB lands here in
      // time to display alongside the streaming assistant chunks the
      // persistent /attach is already delivering.
      if (event.data.status === "in_progress") {
        invalidateMessages();
      }
    },
  });
}
