/** The organization's Plan goals (`PLAN_GOAL_*`), kept live over the watch stream. */

import { useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PlanGoal } from "@decocms/shared/plan-goals";
import type { StudioToolInput as ToolInput } from "@decocms/shared/tools/tool-io";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
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
  return { create, update, archive, pick, similar };
}
