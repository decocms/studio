/** The goal Plan works toward: with Plan goals on, the member's active goal
 *  among the organization's; otherwise the single store goal. */

import {
  useOrgFlag,
  usePlanObjective,
} from "@/hooks/use-organization-settings";
import { usePlanGoals } from "@/hooks/use-plan-goals";
import type { GuideGoal } from "./guide/use-plan-guide.ts";

export function useActivePlanGoal() {
  const goalsOn = useOrgFlag("plan_goals_enabled");
  const goals = usePlanGoals(goalsOn);
  const storeGoal = usePlanObjective()?.statement ?? null;
  const goal: GuideGoal = goalsOn
    ? {
        statement: goals.active?.statement ?? null,
        id: goals.active?.id ?? null,
      }
    : { statement: storeGoal, id: null };
  /** Until the goals load, a case would start toward no goal. */
  const pending = goalsOn && goals.isPending;
  return { goalsOn, goals, goal, pending };
}
