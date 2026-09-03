import { useProjectContext } from "@/sdk";
import type { TaskBoardItemPr } from "@/layouts/task-board/config";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import {
  readCachedTaskPrs,
  writeCachedTaskPrs,
} from "@/lib/task-board-prs-cache";

/** Poll interval for a task's PRs while the dialog is open. The tool fetches
 *  live GitHub state — PR/checks status and the checks→QA hand-off it drives —
 *  so a periodic refresh keeps the review lane moving without a webhook. Kept at
 *  one minute to stay well within GitHub's rate limits, since every poll fans
 *  out to live GitHub PR + checks calls. The query is only active while the
 *  dialog (and thus this hook) is mounted. */
const PRS_POLL_INTERVAL_MS = 60_000;

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
    // Seeded from localStorage so a cold page load paints the last known cards
    // instead of a skeleton. `initialDataUpdatedAt` carries the real age, so
    // React Query treats the seed as already stale and refetches on mount — the
    // card shows a breathing border while it does (`isFetching` in PrCard).
    // Both are FUNCTIONS: React Query only calls them when the key has no
    // cached data, so the parse doesn't run on every render.
    initialData: () =>
      itemId
        ? ((readCachedTaskPrs(locator, itemId)?.data as
            | TaskBoardItemPr[]
            | undefined) ?? undefined)
        : undefined,
    initialDataUpdatedAt: () =>
      itemId ? readCachedTaskPrs(locator, itemId)?.updatedAt : undefined,
    queryFn: async () => {
      const { prs } = await studio.call("TASK_BOARD_ITEM_PRS_GET", {
        taskBoardItemId: itemId!,
      });
      writeCachedTaskPrs(locator, itemId!, prs);
      return prs;
    },
  });
}
