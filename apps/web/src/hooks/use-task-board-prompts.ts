/** Board prompt scopes (`TASK_BOARD_PROMPT_*`) and column automations (`TASK_BOARD_AUTOMATION_*`). */

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

/** Per-column "run the agent when a card lands here" rules. */
export function useTaskBoardColumnAutomations() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.taskBoardColumnAutomations(org.id),
    staleTime: 60_000,
    queryFn: async () =>
      (await studio.call("TASK_BOARD_AUTOMATION_LIST", {})).automations,
  });
}

export interface ColumnRules {
  /** null for the org-wide scope. */
  columnKey: string | null;
  /** Standing instructions and skills for every run on this scope. Omitted
   *  leaves them as saved, so a lane still on its default stays on it. */
  rules?: { prompt: string; skills: string[] };
  /** Column scope only: null = no run on landing; "" = the agent's default. */
  automation?: string | null;
}

/** Save the parts of one scope that changed; empty fields delete their rows. */
export function useSaveColumnRules() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ columnKey, rules, automation }: ColumnRules) => {
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
      if (columnKey !== null && automation !== undefined) {
        await (automation === null
          ? studio.call("TASK_BOARD_AUTOMATION_DELETE", { columnKey })
          : studio.call("TASK_BOARD_AUTOMATION_UPSERT", {
              columnKey,
              prompt: automation.trim() || null,
            }));
      }
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: KEYS.taskBoardPrompts(org.id),
        }),
        queryClient.invalidateQueries({
          queryKey: KEYS.taskBoardColumnAutomations(org.id),
        }),
      ]),
  });
}

const noSnapshot = () => 0;

/** Refetch column rules when any client or agent changes them. Mount once per board. */
export function useTaskBoardRulesLive() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const refetch = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardPrompts(org.id),
      }),
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardColumnAutomations(org.id),
      }),
    ]);
  const subscribe = () =>
    taskBoardRulesWatchView.subscribe(org.slug, refetch, refetch);
  useSyncExternalStore(subscribe, noSnapshot, noSnapshot);
}
