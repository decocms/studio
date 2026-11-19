import { describe, expect, it } from "bun:test";
import { savedStoreGoal } from "./saved-store-goal.ts";

const done = { state: "output-available" };

describe("savedStoreGoal", () => {
  it("sees the hosted built-in and the sandbox's prefixed dynamic tool", () => {
    expect(
      savedStoreGoal([
        { type: "tool-ORGANIZATION_PLAN_OBJECTIVE_SET", ...done },
      ]),
    ).toBe(true);
    expect(
      savedStoreGoal([
        {
          type: "dynamic-tool",
          toolName: "mcp__studio__ORGANIZATION_PLAN_OBJECTIVE_SET",
          ...done,
        },
      ]),
    ).toBe(true);
  });

  it("ignores calls that did not finish", () => {
    for (const state of ["input-available", "output-error", undefined]) {
      expect(
        savedStoreGoal([
          { type: "tool-ORGANIZATION_PLAN_OBJECTIVE_SET", state },
        ]),
      ).toBe(false);
    }
  });

  it("ignores other tools, look-alike names and turns without tools", () => {
    expect(savedStoreGoal([])).toBe(false);
    expect(savedStoreGoal([{ type: "text" }])).toBe(false);
    expect(
      savedStoreGoal([{ type: "tool-ORGANIZATION_SETTINGS_GET", ...done }]),
    ).toBe(false);
    expect(
      savedStoreGoal([
        {
          type: "dynamic-tool",
          toolName: "X_ORGANIZATION_PLAN_OBJECTIVE_SET",
          ...done,
        },
      ]),
    ).toBe(false);
  });
});
