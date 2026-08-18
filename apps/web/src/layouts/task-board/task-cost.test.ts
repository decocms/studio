import { describe, expect, test } from "bun:test";
import { summarizeTaskCost } from "./task-cost";
import type { TaskBoardItemThread } from "./config";

function thread(costUsd: number | null): TaskBoardItemThread {
  return { costUsd } as TaskBoardItemThread;
}

describe("summarizeTaskCost", () => {
  test("returns null when no thread recorded usage", () => {
    expect(summarizeTaskCost([thread(null), thread(null)])).toBeNull();
    expect(summarizeTaskCost(undefined)).toBeNull();
  });

  test("excludes unpriced threads from both the total and the run count", () => {
    const summary = summarizeTaskCost([thread(1.5), thread(null), thread(2)]);
    expect(summary).toEqual({ total: 3.5, runCount: 2 });
  });
});
