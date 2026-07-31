import { useProjectContext } from "@/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

/**
 * Ship a reviewed task: merge its PR + move it to Done via
 * `TASK_BOARD_PROMOTE_TO_PRODUCTION`. On success, refetch the task's PRs (now
 * merged) and activity; the board's status flip arrives over SSE.
 */
export function usePromoteToProduction(itemId: string) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () =>
      await studio.call("TASK_BOARD_PROMOTE_TO_PRODUCTION", {
        taskBoardItemId: itemId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardItemPrs(locator, itemId),
      });
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardActivity(locator, itemId),
      });
    },
  });
}
