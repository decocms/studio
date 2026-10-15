/** Board prompt scopes (`TASK_BOARD_PROMPT_*`). */

import { useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { taskBoardRulesWatchView } from "./watch-sse-pool";

/** Every board prompt scope this org has set, org-wide first. */
export function useTaskBoardPrompts() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.taskBoardPrompts(org.id),
    staleTime: 60_000,
    queryFn: async () =>
      (await studio.call("TASK_BOARD_PROMPT_LIST", {})).prompts,
  });
}

export interface ColumnRules {
  /** null for the org-wide scope. */
  columnKey: string | null;
  /** Standing instructions and skills for every run on this scope. Omitted
   *  leaves them as saved, so a lane still on its default stays on it. */
  rules?: { prompt: string; skills: string[] };
}

/** Save the parts of one scope that changed; empty fields delete their rows. */
export function useSaveColumnRules() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ columnKey, rules }: ColumnRules) => {
      if (rules) {
        const prompt = rules.prompt.trim();
        await (prompt || rules.skills.length
          ? studio.call("TASK_BOARD_PROMPT_UPSERT", {
              columnKey,
              prompt,
              skills: rules.skills,
            })
          : studio.call("TASK_BOARD_PROMPT_DELETE", { columnKey }));
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardPrompts(org.id),
      }),
  });
}

const noSnapshot = () => 0;

/** Refetch column rules when any client or agent changes them. Mount once per board. */
export function useTaskBoardRulesLive() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const refetch = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.taskBoardPrompts(org.id),
    });
  const subscribe = () =>
    taskBoardRulesWatchView.subscribe(org.slug, refetch, refetch);
  useSyncExternalStore(subscribe, noSnapshot, noSnapshot);
}
