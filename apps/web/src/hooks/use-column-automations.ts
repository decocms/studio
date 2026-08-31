/**
 * The rules a board runs when a card lands in a column
 * (`TASK_BOARD_AUTOMATION_*`).
 *
 * Distinct from `use-automations.ts` next door, which is the event/cron
 * trigger surface and shares nothing but the word.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";

export type ColumnAutomation =
  ToolOutput<"TASK_BOARD_AUTOMATION_LIST">["automations"][number];

export function useColumnAutomations() {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const query = useQuery({
    queryKey: KEYS.taskBoardColumnAutomations(locator),
    queryFn: async () => {
      const { automations } = await studio.call(
        "TASK_BOARD_AUTOMATION_LIST",
        {},
      );
      return automations;
    },
  });
  return { automations: query.data ?? [], isPending: query.isPending };
}

/**
 * Turn a column's rule on, off, or reword it.
 *
 * `null` is off: the row is deleted rather than stored empty, so "no rule" has
 * one representation and `automationFor` keeps answering null for it.
 */
export function useSetColumnAutomation() {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { columnKey: string; prompt: string | null }) => {
      if (input.prompt === null) {
        await studio.call("TASK_BOARD_AUTOMATION_DELETE", {
          columnKey: input.columnKey,
        });
        return;
      }
      await studio.call("TASK_BOARD_AUTOMATION_UPSERT", {
        columnKey: input.columnKey,
        prompt: input.prompt.trim() === "" ? undefined : input.prompt,
      });
    },
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: KEYS.taskBoardColumnAutomations(locator),
      }),
  });
}
