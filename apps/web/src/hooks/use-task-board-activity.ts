/** A task's change timeline (created, status and assignee changes). */

import { useProjectContext } from "@/sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";

export type TaskBoardActivity =
  ToolOutput<"TASK_BOARD_ACTIVITY_LIST">["activity"][number];

export function useTaskBoardActivity(itemId: string | undefined) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();

  return useQuery({
    queryKey: KEYS.taskBoardActivity(locator, itemId ?? ""),
    enabled: !!itemId,
    queryFn: async () =>
      (
        await studio.call("TASK_BOARD_ACTIVITY_LIST", {
          taskBoardItemId: itemId!,
        })
      ).activity,
  });
}
