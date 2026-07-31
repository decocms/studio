import { useProjectContext } from "@/sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

/** Poll interval for a task's PRs while the dialog is open. The tool fetches
 *  live GitHub state — PR/checks status and the checks→QA hand-off it drives —
 *  so a short interval keeps the review lane moving without a webhook. The query
 *  is only active while the dialog (and thus this hook) is mounted. */
const PRS_POLL_INTERVAL_MS = 10_000;

/**
 * A task's linked PRs, each with live state fetched from GitHub via the
 * `TASK_BOARD_ITEM_PRS_GET` tool. Enabled only when a task id is present
 * (the create modal has none). Live state (including CI checks) can change
 * while the dialog is open, so poll it.
 */
export function useTaskBoardItemPrs(itemId: string | undefined) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();

  return useQuery({
    queryKey: KEYS.taskBoardItemPrs(locator, itemId ?? ""),
    enabled: !!itemId,
    refetchInterval: PRS_POLL_INTERVAL_MS,
    queryFn: async () =>
      (
        await studio.call("TASK_BOARD_ITEM_PRS_GET", {
          taskBoardItemId: itemId!,
        })
      ).prs,
  });
}
