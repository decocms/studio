/**
 * Plan goals: the organization's list of goals. Any member adds one, any
 * member works toward one, and each member's Plan page opens on the goal they
 * picked. There are no areas or scopes; who uses a goal is what groups people.
 */

import { z } from "zod";
import { PLAN_OBJECTIVE_MAX_LENGTH } from "./organization/schema";

/** One sentence, the same bound as the single store goal it replaces. */
export const PLAN_GOAL_MAX_LENGTH = PLAN_OBJECTIVE_MAX_LENGTH;

/** Goals an org can have open at once, so the picker stays a list to read. */
export const MAX_OPEN_PLAN_GOALS = 50;

/** Pairs of goals a member said are not the same that are remembered and
 *  skipped by the next consolidation check; the oldest go first. */
export const MAX_DISMISSED_PLAN_GOAL_PAIRS = 200;

/** Pushed on the org's watch stream whenever a goal, or who uses one, changes. */
export const PLAN_GOALS_UPDATED_EVENT = "plan.goals.updated";

export const PlanGoalStatementSchema = z
  .string()
  .trim()
  .min(1, "Write the goal in one sentence.")
  .max(PLAN_GOAL_MAX_LENGTH)
  .describe("The goal in one sentence, in the person's own words.");

/** Bounds of where a goal was found: a file or connection name, and a quote. */
export const PLAN_GOAL_SOURCE_LIMITS = {
  label: 200,
  quote: PLAN_GOAL_MAX_LENGTH * 2,
} as const;

/** Where a goal suggested by the AI was found; null when a person wrote it. */
export const PlanGoalSourceSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(PLAN_GOAL_SOURCE_LIMITS.label)
    .describe("What was read: a file or a connection."),
  quote: z
    .string()
    .min(1)
    .max(PLAN_GOAL_SOURCE_LIMITS.quote)
    .describe("The words in that source the goal came from."),
});

export type PlanGoalSource = z.infer<typeof PlanGoalSourceSchema>;

export const PlanGoalSchema = z.object({
  id: z.string(),
  statement: z.string(),
  source: PlanGoalSourceSchema.nullable(),
  created_by: z.string(),
  updated_by: z.string(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  users: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "People working toward the goal: whose Plan opens on it, or who started a case toward it.",
    ),
  last_case_at: z
    .string()
    .datetime()
    .nullable()
    .describe("When the latest business case toward this goal started."),
  mine: z
    .boolean()
    .describe("Whether the caller created this goal or works toward it."),
  can_edit: z
    .boolean()
    .describe(
      "Whether the caller may reword or archive it: its creator or an admin.",
    ),
});

export type PlanGoal = z.infer<typeof PlanGoalSchema>;

/**
 * The picker's two groups: the caller's goals first, then the rest of the
 * org's, the ones more people use first and, between equals, the one with the
 * latest case. Ties end on creation order so the list does not shuffle.
 */
export function groupPlanGoals(goals: readonly PlanGoal[]): {
  yours: PlanGoal[];
  others: PlanGoal[];
} {
  const sorted = [...goals].sort(
    (a, b) =>
      b.users - a.users ||
      (b.last_case_at ?? "").localeCompare(a.last_case_at ?? "") ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
  );
  return {
    yours: sorted.filter((goal) => goal.mine),
    others: sorted.filter((goal) => !goal.mine),
  };
}

/**
 * Which of two goals a merge keeps: the one more people work toward, so fewer
 * people see their goal change, then the older one.
 */
export function planGoalMergeOrder<
  T extends Pick<PlanGoal, "id" | "users" | "created_at">,
>(a: T, b: T): { target: T; source: T } {
  const keepA =
    a.users !== b.users
      ? a.users > b.users
      : a.created_at !== b.created_at
        ? a.created_at < b.created_at
        : a.id < b.id;
  return keepA ? { target: a, source: b } : { target: b, source: a };
}

/** Case-insensitive search over the statement; a blank query keeps all. */
export function filterPlanGoals(
  goals: readonly PlanGoal[],
  query: string,
): PlanGoal[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...goals];
  return goals.filter((goal) =>
    goal.statement.toLocaleLowerCase().includes(needle),
  );
}
