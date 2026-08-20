import { describe, expect, test } from "bun:test";
import { summarizeTaskCost } from "./task-cost";
import type { TaskBoardItemThread } from "./config";

function thread(
  costUsd: number | null,
  costProvider: string | null = "claude-subscription",
): TaskBoardItemThread {
  return { costUsd, costProvider } as TaskBoardItemThread;
}

describe("summarizeTaskCost", () => {
  test("returns null when no thread recorded usage", () => {
    expect(summarizeTaskCost([thread(null), thread(null)])).toBeNull();
    expect(summarizeTaskCost(undefined)).toBeNull();
  });

  test("excludes unpriced threads from both the total and the run count", () => {
    const summary = summarizeTaskCost([thread(1.5), thread(null), thread(2)]);
    expect(summary).toEqual({
      total: 3.5,
      runCount: 2,
      onSubscription: true,
    });
  });

  test("onSubscription only when every priced run billed the Claude plan", () => {
    expect(
      summarizeTaskCost([thread(1, "claude-subscription"), thread(1, "deco")]),
    ).toMatchObject({ onSubscription: false });
    expect(
      summarizeTaskCost([thread(1, "claude-subscription"), thread(1, null)]),
    ).toMatchObject({ onSubscription: false });
  });

  test("an unpriced run of another provider cannot sink onSubscription", () => {
    expect(
      summarizeTaskCost([
        thread(1, "claude-subscription"),
        thread(null, "openrouter"),
      ]),
    ).toMatchObject({ onSubscription: true });
  });
});
