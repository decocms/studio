/**
 * The idempotency guard that stops a reviewer run from being re-enqueued on
 * every 10s poll / re-trigger — and, critically, that DOES let reviewers re-run
 * on a fresh review cycle (a stale prior-cycle thread must not count). Pure over
 * a task snapshot + the cycle-start timestamp.
 */
import { describe, expect, it, test } from "bun:test";
import type { TaskBoardItem } from "@/storage/types";
import {
  MAX_REVIEWER_ATTEMPTS,
  REVIEWER_DISALLOWED_TOOLS,
  reviewerAttemptsExhausted,
  reviewerHandledThisCycle,
  spentAttemptsThisCycle,
} from "./enqueue-reviewer";
import { REVIEW_RUN_TOOL_NAMES } from "./task-run-context";

/** Cycle start (the task last entered In Review) at 10:00. */
const CYCLE_START = new Date("2026-01-01T10:00:00Z").getTime();
/** "Now" for every liveness check below — ten minutes into the cycle. */
const NOW = new Date("2026-01-01T10:10:00Z").getTime();

/**
 * `lastActiveAt` defaults to `createdAt`, which for these fixtures is inside
 * the stall window relative to `NOW` — so a non-terminal thread reads as live
 * unless a test deliberately backdates it.
 */
const thread = (o: {
  title: string;
  status: string | null;
  createdAt: string;
  lastActiveAt?: string;
}) => ({
  threadId: `t-${o.createdAt}-${o.lastActiveAt ?? ""}`,
  ...o,
  lastActiveAt: o.lastActiveAt ?? o.createdAt,
});

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
        lastActiveAt: "2026-01-01T10:09:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START, NOW)).toBe(true);
  });

  it("is true for a terminal reviewer thread created THIS cycle", () => {
    const task = taskWith([
      thread({
        title: "QA Agent: fix",
        status: "completed",
        createdAt: "2026-01-01T10:05:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START, NOW)).toBe(true);
  });

  it("is FALSE for a terminal reviewer thread from a PRIOR cycle — so re-review re-runs it", () => {
    const task = taskWith([
      thread({
        title: "QA Agent: fix",
        status: "completed",
        createdAt: "2026-01-01T09:30:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START, NOW)).toBe(false);
  });

  // The bug: a FAILED reviewer thread satisfied "created this cycle", so when
  // both reviewers died on a database-connection timeout the card sat In Review
  // with two dead reviewer threads and no verdicts. A failure is not a review.
  it("is FALSE for a reviewer thread that FAILED this cycle — it gets retried", () => {
    const task = taskWith([
      thread({
        title: "QA Agent: fix",
        status: "failed",
        createdAt: "2026-01-01T10:05:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START, NOW)).toBe(false);
    expect(spentAttemptsThisCycle(task, "qa", CYCLE_START, NOW)).toBe(1);
  });

  /**
   * The deadlock. A reviewer whose pod dies mid-run keeps `in_progress`
   * forever: the per-pod idle reaper can't see it and `failNeverStartedThreads`
   * only covers runs that never started. Taking the status at face value made
   * the thread own the cycle permanently — nothing re-dispatched, and a merge
   * gate waiting on a verdict that was never coming. One card sat
   * that way while its co-reviewer had approved in 68 seconds.
   */
  it("is FALSE for a non-terminal thread whose heartbeat went cold", () => {
    const task = taskWith([
      thread({
        title: "QA Agent: fix",
        status: "in_progress",
        createdAt: "2026-01-01T10:01:00Z",
        lastActiveAt: "2026-01-01T09:30:00Z", // past the stall window
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START, NOW)).toBe(false);
    // …and it counts as an attempt, so the retry fences on a fresh id
    // instead of colliding with the corpse.
    expect(spentAttemptsThisCycle(task, "qa", CYCLE_START, NOW)).toBe(1);
  });

  it("a warm heartbeat still owns the cycle — a slow reviewer is not a hung one", () => {
    const task = taskWith([
      thread({
        title: "QA Agent: fix",
        status: "in_progress",
        createdAt: "2026-01-01T10:01:00Z",
        lastActiveAt: "2026-01-01T10:09:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START, NOW)).toBe(true);
    expect(spentAttemptsThisCycle(task, "qa", CYCLE_START, NOW)).toBe(0);
  });

  // The opposite mistake to the deadlock: a reviewer whose pod keeps dying must
  // not be re-dispatched forever just because it never wrote `failed`.
  it("hung attempts count toward the budget, like failures", () => {
    const task = taskWith(
      Array.from({ length: MAX_REVIEWER_ATTEMPTS }, (_, i) =>
        thread({
          title: "QA Agent: fix",
          status: "in_progress",
          createdAt: `2026-01-01T10:0${i + 1}:00Z`,
          lastActiveAt: "2026-01-01T09:30:00Z",
        }),
      ),
    );
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START, NOW)).toBe(true);
    expect(reviewerAttemptsExhausted(task, "qa", CYCLE_START, NOW)).toBe(true);
  });

  it("stops retrying once the cycle has spent MAX_REVIEWER_ATTEMPTS", () => {
    const task = taskWith(
      Array.from({ length: MAX_REVIEWER_ATTEMPTS }, (_, i) =>
        thread({
          title: "QA Agent: fix",
          status: "failed",
          createdAt: `2026-01-01T10:0${i + 1}:00Z`,
        }),
      ),
    );
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START, NOW)).toBe(true);
    // …and says WHY: no verdict is coming, so the card needs a human.
    expect(reviewerAttemptsExhausted(task, "qa", CYCLE_START, NOW)).toBe(true);
  });

  it("a completed review alongside a failed attempt is still handled", () => {
    const task = taskWith([
      thread({
        title: "QA Agent: fix",
        status: "failed",
        createdAt: "2026-01-01T10:01:00Z",
      }),
      thread({
        title: "QA Agent: fix",
        status: "completed",
        createdAt: "2026-01-01T10:06:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START, NOW)).toBe(true);
  });

  // A retry must never run alongside a live attempt.
  it("a live attempt wins over a failed one", () => {
    const task = taskWith([
      thread({
        title: "QA Agent: fix",
        status: "failed",
        createdAt: "2026-01-01T10:01:00Z",
      }),
      thread({
        title: "QA Agent: fix",
        status: "in_progress",
        createdAt: "2026-01-01T10:06:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START, NOW)).toBe(true);
  });

  it("a failure from a PRIOR cycle is not a spent attempt of this one", () => {
    const task = taskWith([
      thread({
        title: "QA Agent: fix",
        status: "failed",
        createdAt: "2026-01-01T09:30:00Z",
      }),
    ]);
    expect(spentAttemptsThisCycle(task, "qa", CYCLE_START, NOW)).toBe(0);
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
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START, NOW)).toBe(false);
    expect(
      reviewerHandledThisCycle(task, "code_review", CYCLE_START, NOW),
    ).toBe(true);
  });
});

describe("reviewerAttemptsExhausted", () => {
  const failed = (createdAt: string) =>
    thread({ title: "QA Agent: fix", status: "failed", createdAt });

  it("is false below the attempt budget", () => {
    const task = taskWith([failed("2026-01-01T10:01:00Z")]);
    expect(reviewerAttemptsExhausted(task, "qa", CYCLE_START, NOW)).toBe(false);
  });

  // The distinction that matters: `reviewerHandledThisCycle` is also true for a
  // reviewer that ran fine, and that card must NOT be handed to a human.
  it("is false when a review actually completed", () => {
    const task = taskWith([
      failed("2026-01-01T10:01:00Z"),
      thread({
        title: "QA Agent: fix",
        status: "completed",
        createdAt: "2026-01-01T10:02:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "qa", CYCLE_START, NOW)).toBe(true);
    expect(reviewerAttemptsExhausted(task, "qa", CYCLE_START, NOW)).toBe(false);
  });

  it("is false while an attempt is still live", () => {
    const task = taskWith([
      failed("2026-01-01T10:01:00Z"),
      thread({
        title: "QA Agent: fix",
        status: "in_progress",
        createdAt: "2026-01-01T10:02:00Z",
      }),
    ]);
    expect(reviewerAttemptsExhausted(task, "qa", CYCLE_START, NOW)).toBe(false);
  });

  it("ignores failures from a prior cycle", () => {
    const task = taskWith([
      failed("2026-01-01T09:00:00Z"),
      failed("2026-01-01T09:30:00Z"),
    ]);
    expect(reviewerAttemptsExhausted(task, "qa", CYCLE_START, NOW)).toBe(false);
  });

  it("scopes to the given reviewer", () => {
    const task = taskWith([
      failed("2026-01-01T10:01:00Z"),
      failed("2026-01-01T10:02:00Z"),
    ]);
    expect(
      reviewerAttemptsExhausted(task, "code_review", CYCLE_START, NOW),
    ).toBe(false);
  });
});
