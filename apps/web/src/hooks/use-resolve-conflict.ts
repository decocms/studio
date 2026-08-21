import { useProjectContext } from "@/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

/**
 * Hand a conflicting PR back to the Super Agent to resolve, via
 * `TASK_BOARD_RESOLVE_CONFLICT`. On success, refetch the task's PRs and
 * activity; the board's status flip (In Review → In Progress) arrives over SSE.
 */
export function useResolveConflict(itemId: string) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (prNumber: number) =>
      await studio.call("TASK_BOARD_RESOLVE_CONFLICT", {
        id: itemId,
        prNumber,
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
