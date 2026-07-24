/** A task's change timeline (created, status/assignee/sprint changes). */

import { useProjectContext } from "@decocms/mesh-sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { useStudioTools } from "@/web/lib/studio-tools";
import type { ToolOutput } from "@/tools/io-types";

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
