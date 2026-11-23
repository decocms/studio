/** The organization's Plan goals (`PLAN_GOAL_*`), kept live over the watch stream. */

import { useSyncExternalStore } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import {
  MAX_DISMISSED_PLAN_GOAL_PAIRS,
  planGoalMergeOrder,
  type PlanGoal,
} from "@decocms/shared/plan-goals";
import type { StudioToolInput as ToolInput } from "@decocms/shared/tools/tool-io";
import { useProjectContext } from "@/sdk";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useLocalStorage } from "./use-local-storage";
import { planGoalsWatchView } from "./watch-sse-pool";

const NO_GOALS: PlanGoal[] = [];

export interface PlanGoals {
  goals: PlanGoal[];
  /** The goal the member's Plan opens on; null while loading or with none. */
  active: PlanGoal | null;
  isPending: boolean;
}

const noSnapshot = () => 0;

function useInvalidatePlanGoals() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: KEYS.planGoalsAll(org.id) });
}

/** Refetch when anyone, a person or an agent, changes a goal. Mount once
 *  per Plan page. */
export function usePlanGoalsLive() {
  const { org } = useProjectContext();
  const refetch = useInvalidatePlanGoals();
  const subscribe = () =>
    planGoalsWatchView.subscribe(org.slug, refetch, refetch);
  useSyncExternalStore(subscribe, noSnapshot, noSnapshot);
}

/** Off with `enabled` false: the first read seeds the org's goals from its
 *  single store goal, which must wait until the org turns goals on. */
export function usePlanGoals(enabled = true): PlanGoals {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const { data, isPending } = useQuery({
    queryKey: KEYS.planGoals(org.id),
    enabled,
    staleTime: 60_000,
    queryFn: () => studio.call("PLAN_GOAL_LIST", {}),
  });
  const goals = data?.goals ?? NO_GOALS;
  return {
    goals,
    active: goals.find((goal) => goal.id === data?.active_goal_id) ?? null,
    isPending,
  };
}

/** The case chats anyone started toward a goal, newest first. */
export function usePlanGoalCases(goalId: string | null): string[] | undefined {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const { data } = useQuery({
    queryKey: KEYS.planGoalCases(org.id, goalId ?? ""),
    enabled: goalId !== null,
    staleTime: 60_000,
    queryFn: async () =>
      (await studio.call("PLAN_GOAL_CASES", { goal_id: goalId ?? "" }))
        .thread_ids,
  });
  return data;
}

export function usePlanGoalActions() {
  const studio = useStudioTools();
  const invalidate = useInvalidatePlanGoals();
  const create = useMutation({
    mutationFn: (input: ToolInput<"PLAN_GOAL_CREATE">) =>
      studio.call("PLAN_GOAL_CREATE", input),
    onSettled: invalidate,
  });
  const update = useMutation({
    mutationFn: (input: ToolInput<"PLAN_GOAL_UPDATE">) =>
      studio.call("PLAN_GOAL_UPDATE", input),
    onSettled: invalidate,
  });
  const archive = useMutation({
    mutationFn: (input: ToolInput<"PLAN_GOAL_ARCHIVE">) =>
      studio.call("PLAN_GOAL_ARCHIVE", input),
    onSettled: invalidate,
  });
  const pick = useMutation({
    mutationFn: (input: ToolInput<"PLAN_ACTIVE_GOAL_SET">) =>
      studio.call("PLAN_ACTIVE_GOAL_SET", input),
    onSettled: invalidate,
  });
  /** The open goals that already say what the person is about to add. */
  const similar = useMutation({
    mutationFn: (input: ToolInput<"PLAN_GOAL_SIMILAR">) =>
      studio.call("PLAN_GOAL_SIMILAR", input),
  });
  const merge = useMutation({
    mutationFn: (input: ToolInput<"PLAN_GOAL_MERGE">) =>
      studio.call("PLAN_GOAL_MERGE", input),
    onSettled: invalidate,
  });
  return { create, update, archive, pick, similar, merge };
}

/** Two open goals proposed for a merge: `target` stays, `source` goes. */
export interface PlanGoalPair {
  key: string;
  target: PlanGoal;
  source: PlanGoal;
}

const DismissedPairsSchema = z.array(z.string());

/**
 * Pairs of open goals that look like the same goal and that the member may
 * merge, minus the ones they said are not the same in this browser. Asked
 * again only when a goal is added, reworded or leaves the list.
 */
export function usePlanGoalDuplicates(goals: PlanGoal[]) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const [dismissed, setDismissed] = useLocalStorage<string[]>(
    LOCALSTORAGE_KEYS.planGoalPairsDismissed(org.id),
    (stored) => DismissedPairsSchema.catch([]).parse(stored ?? []),
  );
  const signature = goals
    .map((goal) => `${goal.id}@${goal.updated_at}`)
    .sort()
    .join(",");
  const { data } = useQuery({
    queryKey: KEYS.planGoalDuplicates(org.id, signature),
    enabled: goals.length > 1,
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
    queryFn: () =>
      studio.call("PLAN_GOAL_DUPLICATES", {
        dismissed: dismissed.slice(-MAX_DISMISSED_PLAN_GOAL_PAIRS),
      }),
  });
  const byId = new Map(goals.map((goal) => [goal.id, goal]));
  const pairs: PlanGoalPair[] = (data?.pairs ?? []).flatMap((pair) => {
    const a = byId.get(pair.a.id);
    const b = byId.get(pair.b.id);
    if (!a || !b || dismissed.includes(pair.key)) return [];
    return [{ key: pair.key, ...planGoalMergeOrder(a, b) }];
  });
  const dismiss = (key: string) =>
    setDismissed((prev) =>
      [...prev.filter((other) => other !== key), key].slice(
        -MAX_DISMISSED_PLAN_GOAL_PAIRS,
      ),
    );
  return { pairs, dismiss };
}
