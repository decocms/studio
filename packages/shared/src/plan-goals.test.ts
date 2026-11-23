import { describe, expect, test } from "bun:test";
import {
  filterPlanGoals,
  groupPlanGoals,
  planGoalKey,
  PlanGoalStatementSchema,
  PLAN_GOAL_MAX_LENGTH,
  type PlanGoal,
} from "./plan-goals";

function goal(overrides: Partial<PlanGoal> & { id: string }): PlanGoal {
  return {
    statement: `Goal ${overrides.id}`,
    source: null,
    created_by: "user_a",
    updated_by: "user_a",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    users: 0,
    last_case_at: null,
    mine: false,
    can_edit: false,
    ...overrides,
  };
}

describe("groupPlanGoals", () => {
  test("puts the caller's goals first and ranks each group by people, then latest case, then age", () => {
    const { yours, others } = groupPlanGoals([
      goal({ id: "old-quiet", created_at: "2026-01-01T00:00:00.000Z" }),
      goal({ id: "new-quiet", created_at: "2026-02-01T00:00:00.000Z" }),
      goal({ id: "busy", users: 4 }),
      goal({
        id: "recent",
        users: 1,
        last_case_at: "2026-03-02T00:00:00.000Z",
      }),
      goal({ id: "stale", users: 1, last_case_at: "2026-03-01T00:00:00.000Z" }),
      goal({ id: "mine-small", mine: true, users: 1 }),
      goal({ id: "mine-big", mine: true, users: 3 }),
    ]);
    expect(yours.map((g) => g.id)).toEqual(["mine-big", "mine-small"]);
    expect(others.map((g) => g.id)).toEqual([
      "busy",
      "recent",
      "stale",
      "old-quiet",
      "new-quiet",
    ]);
  });

  test("handles no goals", () => {
    expect(groupPlanGoals([])).toEqual({ yours: [], others: [] });
  });
});

describe("filterPlanGoals", () => {
  const goals = [
    goal({ id: "a", statement: "Grow online REVENUE" }),
    goal({ id: "b", statement: "Cut returns" }),
  ];

  test("matches the statement without regard to case", () => {
    expect(filterPlanGoals(goals, " revenue ").map((g) => g.id)).toEqual(["a"]);
  });

  test("keeps every goal for a blank query", () => {
    expect(filterPlanGoals(goals, "  ")).toHaveLength(2);
  });
});

describe("planGoalKey", () => {
  test("treats goals that differ only in case, punctuation or spacing as one", () => {
    const key = planGoalKey("Make the app our main sales channel in 2027.");
    expect(planGoalKey("  make the APP our main sales-channel in 2027! ")).toBe(
      key,
    );
    expect(planGoalKey("“Make the app our main sales channel in 2027”")).toBe(
      key,
    );
  });

  test("keeps goals with different words apart, accents included", () => {
    expect(planGoalKey("Vender mais no app")).not.toBe(
      planGoalKey("Vender mais no site"),
    );
    expect(planGoalKey("Reduzir trocas")).not.toBe(
      planGoalKey("Reduzir troças"),
    );
  });

  test("leaves nothing of a statement that is only punctuation", () => {
    expect(planGoalKey(" ... !? ")).toBe("");
  });
});

describe("PlanGoalStatementSchema", () => {
  test("trims, and refuses blank or oversized sentences", () => {
    expect(PlanGoalStatementSchema.parse("  Grow  ")).toBe("Grow");
    expect(PlanGoalStatementSchema.safeParse("   ").success).toBe(false);
    expect(
      PlanGoalStatementSchema.safeParse("x".repeat(PLAN_GOAL_MAX_LENGTH + 1))
        .success,
    ).toBe(false);
    expect(
      PlanGoalStatementSchema.safeParse("x".repeat(PLAN_GOAL_MAX_LENGTH))
        .success,
    ).toBe(true);
  });
});
