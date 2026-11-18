import type {
  PlanGoal,
  PlanObjective,
} from "@decocms/shared/organization/schema";
import type { StudioToolOutput } from "@decocms/shared/tools/tool-io";

type Decision = StudioToolOutput<"ORGANIZATION_PLAN_OBJECTIVE_DECIDE">;
export type NoGoalReason = NonNullable<Decision["reason"]>;

export type GoalReview =
  | { kind: "same" }
  | { kind: "write"; goal: PlanGoal }
  | { kind: "none"; reason: NoGoalReason };

/** Keep the goal Jev picked before, replace anything else, keep it all without an answer. */
export function reviewStoreGoal(
  current: PlanObjective | null,
  result: Decision,
): GoalReview {
  if (!result.decision)
    return { kind: "none", reason: result.reason ?? "unavailable" };
  const { goal } = result.decision;
  return current?.source === "jev" && current.goal === goal
    ? { kind: "same" }
    : { kind: "write", goal };
}
