/**
 * The idempotency guard that stops a reviewer run from being re-enqueued on
 * every 10s poll / re-trigger — and, critically, that DOES let reviewers re-run
 * on a fresh review cycle (a stale prior-cycle thread must not count). Pure over
 * a task snapshot + the cycle-start timestamp.
 */
import { describe, expect, it, test } from "bun:test";
import type { TaskBoardItem } from "@/storage/types";
import {
  REVIEWER_DISALLOWED_TOOLS,
  reviewerHandledThisCycle,
} from "./enqueue-reviewer";
import { REVIEW_RUN_TOOL_NAMES } from "./task-run-context";

/** Cycle start (the task last entered In Review) at 10:00. */
const CYCLE_START = new Date("2026-01-01T10:00:00Z").getTime();

const thread = (o: {
  title: string;
  status: string | null;
  createdAt: string;
}) => ({ threadId: `t-${o.createdAt}`, ...o });

const taskWith = (threads: ReturnType<typeof thread>[]): TaskBoardItem =>
  ({ threads }) as unknown as TaskBoardItem;

describe("REVIEWER_DISALLOWED_TOOLS", () => {
  // `disallowedTools` matches SDK tool NAMES. A permission-rule pattern
  // (`Bash(git push:*)`) is not one, so it would be a silent no-op that reads
  // like a guard — the exact mistake this test exists to catch.
  test("holds plain built-in tool names, never permission patterns", () => {
    for (const names of Object.values(REVIEWER_DISALLOWED_TOOLS)) {
      for (const name of names) {
        expect(name).toMatch(/^[A-Za-z]+$/);
      }
    }
  });

  // The reviewer's whole job runs through the task-run MCP surface (find the
  // PR, record the verdict). Removing one of those would strand the review the
  // same way the missing `TASK_BOARD_REVIEW_DECISION` did.
  test("never removes a tool the reviewer's MCP surface provides", () => {
    for (const names of Object.values(REVIEWER_DISALLOWED_TOOLS)) {
      for (const name of names) {
        expect(name.startsWith("mcp__")).toBe(false);
        expect(REVIEW_RUN_TOOL_NAMES).not.toContain(name);
      }
    }
  });
});

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
