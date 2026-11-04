import { describe, expect, test } from "bun:test";
import type { CampaignGoal } from "@decocms/shared/blog-campaign";
import { currentGoalIndex } from "./campaign-page";

const goal = (text: string): CampaignGoal => ({
  text,
  metric: null,
  target: "",
});

describe("currentGoalIndex", () => {
  const a = goal("A");
  const b = goal("B");
  const c = goal("C");

  test("a goal still where it was opened is edited there", () => {
    expect(currentGoalIndex([a, b, c], { index: 1, goal: b })).toBe(1);
  });

  test("a goal the agent moved is found where it is now", () => {
    expect(currentGoalIndex([goal("N"), a, b, c], { index: 1, goal: b })).toBe(
      2,
    );
  });

  test("a goal that changed or left is not edited by its old place", () => {
    expect(currentGoalIndex([a, goal("B2"), c], { index: 1, goal: b })).toBe(
      -1,
    );
    expect(currentGoalIndex([a], { index: 1, goal: b })).toBe(-1);
  });
});
