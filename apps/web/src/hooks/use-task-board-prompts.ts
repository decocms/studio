/**
 * Board system prompts (`TASK_BOARD_PROMPT_*`) — instructions appended to the
 * system prompt of every agent run started from a card. The org-wide prompt is
 * the row with a null `columnKey`; per-column rows share the same table and are
 * not written from the UI yet.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

/** The org-wide board prompt, or "" when none is set. */
export function useOrgTaskBoardPrompt() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const query = useQuery({
    queryKey: KEYS.taskBoardPrompts(org.id),
    staleTime: 60_000,
    queryFn: async () =>
      (await studio.call("TASK_BOARD_PROMPT_LIST", {})).prompts,
  });
  return {
    prompt: query.data?.find((p) => p.columnKey === null)?.prompt ?? "",
    isPending: query.isPending,
  };
}

/**
 * Write the org-wide board prompt. An empty string DELETES the row rather than
 * storing a blank one — "no prompt" must have exactly one representation, or
 * the dispatch path has to trim on every read.
 */
export function useSetOrgTaskBoardPrompt() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) {
        await studio.call("TASK_BOARD_PROMPT_DELETE", {});
        return;
      }
      await studio.call("TASK_BOARD_PROMPT_UPSERT", { prompt: trimmed });
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardPrompts(org.id),
      }),
  });
}
