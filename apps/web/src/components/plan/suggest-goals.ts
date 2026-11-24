import {
  PLAN_GOAL_SOURCE_LIMITS,
  type PlanGoalSource,
} from "@decocms/shared/plan-goals";
import type { StudioToolOutput } from "@decocms/shared/tools/tool-io";
import type { FindNotice } from "./find-store-goal.ts";

export type GoalSuggestions = StudioToolOutput<"PLAN_GOAL_SUGGEST">;
export type GoalSuggestion = GoalSuggestions["candidates"][number];

type MissingNotice = Extract<FindNotice, { kind: "missing" }>;

/** Where the AI found a goal, cut to what a saved goal keeps. */
export function goalSource(label: string, quote: string): PlanGoalSource {
  return {
    label: label.slice(0, PLAN_GOAL_SOURCE_LIMITS.label),
    quote: quote.slice(0, PLAN_GOAL_SOURCE_LIMITS.quote),
  };
}

/** Why Suggest goals found nothing to review, with what it read; null when it found some. */
export function suggestionsNotice(
  result: GoalSuggestions,
): MissingNotice | null {
  if (result.candidates.length > 0) return null;
  return {
    kind: "missing",
    message:
      result.reason === "unavailable"
        ? "plan.objective.findUnavailable"
        : result.reason === "already_listed"
          ? "plan.goals.suggest.allListed"
          : "plan.goals.suggest.notFound",
    read: result.read,
    unread: result.unread,
  };
}

/** The source a goal keeps on save: the suggestion's, while its sentence is unchanged. */
export function keptSource(
  source: PlanGoalSource | null,
  initial: string,
  statement: string,
): PlanGoalSource | null {
  return source && statement.trim() === initial.trim() ? source : null;
}
