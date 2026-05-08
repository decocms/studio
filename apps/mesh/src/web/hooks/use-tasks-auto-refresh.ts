import { useProjectContext } from "@decocms/mesh-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { useDecopilotEvents } from "@/web/hooks/use-decopilot-events";

/**
 * Subscribe to org-wide `decopilot.thread.status` SSE events and invalidate
 * the tasks list so the global tasks panel picks up new/changed tasks
 * (including ones not yet in the cached list) without a manual refresh.
 */
export function useTasksAutoRefresh() {
  const { org, locator } = useProjectContext();
  const queryClient = useQueryClient();

  useDecopilotEvents({
    orgSlug: org.slug,
    onTaskStatus: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.tasksPrefix(locator),
      });
    },
  });
}
