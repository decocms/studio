import { useProjectContext } from "@/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

/**
 * Ask for a review of a task the org's automated Reviewer never ran on, via
 * `TASK_BOARD_RUN_REVIEWER`. On success, refetch the task's activity (the
 * "delegated to Reviewer" entry); the reviewer's linked thread arrives over SSE.
 *
 * `queued: false` is a success with nothing dispatched — a reviewer already
 * holds this review cycle. The caller says so rather than claiming a run.
 */
export function useRunReviewer(itemId: string) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () =>
      await studio.call("TASK_BOARD_RUN_REVIEWER", { id: itemId }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardActivity(locator, itemId),
      });
    },
  });
}
