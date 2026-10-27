import { describe, expect, test } from "bun:test";
import { TaskBoardHarnessSchema } from "@decocms/shared/task-board";
import { taskRunHarness } from "./task-run-harness";

describe("task harness selection", () => {
  test("legacy tasks and omitted selections keep Claude Code", () => {
    expect(taskRunHarness(undefined)).toBe("claude-code");
    expect(taskRunHarness("claude-code", "new_task")).toBe("claude-code");
  });

  test("Codex survives implementation retries", () => {
    for (const runClass of ["new_task", "retry"] as const) {
      expect(taskRunHarness("codex", runClass)).toBe("codex");
    }
  });

  test("reviewers keep their own runtime", () => {
    expect(taskRunHarness("codex", "reviewer")).toBe("claude-code");
  });

  test("the public selector rejects invalid and non-hosted harnesses", () => {
    for (const value of [
      null,
      "",
      "Codex",
      "decopilot",
      "opencode",
      {},
      "x".repeat(10000),
    ]) {
      expect(TaskBoardHarnessSchema.safeParse(value).success).toBe(false);
    }
    for (const value of ["codex", "claude-code"] as const) {
      expect(TaskBoardHarnessSchema.parse(value)).toBe(value);
    }
  });
});
