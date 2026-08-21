import { useProjectContext } from "@/sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";

type TaskBoardItem = ToolOutput<"TASK_BOARD_ITEM_LIST">["items"][number];

/**
 * The task board item a chat thread is linked to, or null — derived from the
 * task list (each item carries its linked `threads`), so no dedicated tool is
 * needed. Shares the board's query key so the list is fetched once and cached.
 */
export function useBoardTaskForThread(
  threadId: string | undefined,
): TaskBoardItem | null {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const { data } = useQuery({
    queryKey: KEYS.taskBoardItems(locator),
    queryFn: async () => (await studio.call("TASK_BOARD_ITEM_LIST", {})).items,
  });
  if (!threadId || !data) return null;
  return (
    data.find((item) => item.threads.some((t) => t.threadId === threadId)) ??
    null
  );
}
