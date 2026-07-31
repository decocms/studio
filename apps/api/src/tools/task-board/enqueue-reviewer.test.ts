/**
 * The idempotency guard that stops a reviewer run from being re-enqueued on
 * every 10s poll / re-trigger — and, critically, that DOES let reviewers re-run
 * on a fresh review cycle (a stale prior-cycle thread must not count). Pure over
 * a task snapshot + the cycle-start timestamp.
 */
import { describe, expect, it } from "bun:test";
import type { TaskBoardItem } from "@/storage/types";
import { reviewerHandledThisCycle } from "./enqueue-reviewer";

/** Cycle start (the task last entered In Review) at 10:00. */
const CYCLE_START = new Date("2026-01-01T10:00:00Z").getTime();

const thread = (o: {
  title: string;
  status: string | null;
  createdAt: string;
}) => ({ threadId: `t-${o.createdAt}`, ...o });

const taskWith = (threads: ReturnType<typeof thread>[]): TaskBoardItem =>
  ({ threads }) as unknown as TaskBoardItem;

describe("reviewerHandledThisCycle", () => {
  it("is true while a reviewer's own thread is still live", () => {
    const task = taskWith([
      thread({
        title: "QA Agent: fix",
        status: "in_progress",
        createdAt: "2026-01-01T09:00:00Z", // even from a prior cycle, live counts
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START)).toBe(true);
  });

  it("is true for a terminal reviewer thread created THIS cycle", () => {
    const task = taskWith([
      thread({
        title: "QA Agent: fix",
        status: "completed",
        createdAt: "2026-01-01T10:05:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START)).toBe(true);
  });

  it("is FALSE for a terminal reviewer thread from a PRIOR cycle — so re-review re-runs it", () => {
    const task = taskWith([
      thread({
        title: "QA Agent: fix",
        status: "completed",
        createdAt: "2026-01-01T09:30:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START)).toBe(false);
  });

  it("scopes to the given reviewer — the other reviewer's thread and the Super Agent's don't count", () => {
    const task = taskWith([
      thread({
        title: "Super Agent: fix",
        status: "completed",
        createdAt: "2026-01-01T10:05:00Z",
      }),
      thread({
        title: "Code Reviewer: fix",
        status: "in_progress",
        createdAt: "2026-01-01T10:05:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START)).toBe(false);
    expect(reviewerHandledThisCycle(task, "code_review", CYCLE_START)).toBe(
      true,
    );
  });
});
