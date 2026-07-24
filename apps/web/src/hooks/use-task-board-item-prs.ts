import { useProjectContext } from "@/sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

/**
 * A task's linked PRs, each with live state fetched from GitHub via the
 * `TASK_BOARD_ITEM_PRS_GET` tool. Enabled only when a task id is present
 * (the create modal has none). Live state can go stale, so refetch on open.
 */
export function useTaskBoardItemPrs(itemId: string | undefined) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();

  return useQuery({
    queryKey: KEYS.taskBoardItemPrs(locator, itemId ?? ""),
    enabled: !!itemId,
    queryFn: async () =>
      (
        await studio.call("TASK_BOARD_ITEM_PRS_GET", {
          taskBoardItemId: itemId!,
        })
      ).prs,
  });
}
