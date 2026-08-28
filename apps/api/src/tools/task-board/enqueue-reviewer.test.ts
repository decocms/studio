/**
 * The idempotency guard that stops a reviewer run from being re-enqueued on
 * every 10s poll / re-trigger — and, critically, that DOES let reviewers re-run
 * on a fresh review cycle (a stale prior-cycle thread must not count). Pure over
 * a task snapshot + the cycle-start timestamp.
 */
import { describe, expect, it } from "bun:test";
import type { TaskBoardItem } from "@/storage/types";
import {
  authorRunLive,
  MAX_REVIEWER_ATTEMPTS,
  reviewerAttemptsExhausted,
  pinnedRepoConnectionId,
  priorCycleReviewAt,
  reviewerHandledThisCycle,
  spentAttemptsThisCycle,
  stalePreviewHandoffDue,
  undecidedReviewerThread,
  verdictNudgedThreads,
  awaitingVerdictNudge,
} from "./enqueue-reviewer";

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

describe("reviewerHandledThisCycle", () => {
  it("is true while a reviewer's own thread is still live", () => {
    const task = taskWith([
      thread({
        title: "Reviewer: fix",
        status: "in_progress",
        createdAt: "2026-01-01T09:00:00Z", // even from a prior cycle, live counts
        lastActiveAt: "2026-01-01T10:09:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(
      true,
    );
  });

  it("is true for a terminal reviewer thread created THIS cycle", () => {
    const task = taskWith([
      thread({
        title: "Reviewer: fix",
        status: "completed",
        createdAt: "2026-01-01T10:05:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(
      true,
    );
  });

  it("is FALSE for a terminal reviewer thread from a PRIOR cycle — so re-review re-runs it", () => {
    const task = taskWith([
      thread({
        title: "Reviewer: fix",
        status: "completed",
        createdAt: "2026-01-01T09:30:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(
      false,
    );
  });

  // The bug: a FAILED reviewer thread satisfied "created this cycle", so when
  // both reviewers died on a database-connection timeout the card sat In Review
  // with two dead reviewer threads and no verdicts. A failure is not a review.
  it("is FALSE for a reviewer thread that FAILED this cycle — it gets retried", () => {
    const task = taskWith([
      thread({
        title: "Reviewer: fix",
        status: "failed",
        createdAt: "2026-01-01T10:05:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(
      false,
    );
    expect(spentAttemptsThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(1);
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
        title: "Reviewer: fix",
        status: "in_progress",
        createdAt: "2026-01-01T10:01:00Z",
        lastActiveAt: "2026-01-01T09:30:00Z", // past the stall window
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(
      false,
    );
    // …and it counts as an attempt, so the retry fences on a fresh id
    // instead of colliding with the corpse.
    expect(spentAttemptsThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(1);
  });

  it("a warm heartbeat still owns the cycle — a slow reviewer is not a hung one", () => {
    const task = taskWith([
      thread({
        title: "Reviewer: fix",
        status: "in_progress",
        createdAt: "2026-01-01T10:01:00Z",
        lastActiveAt: "2026-01-01T10:09:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(
      true,
    );
    expect(spentAttemptsThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(0);
  });

  // The opposite mistake to the deadlock: a reviewer whose pod keeps dying must
  // not be re-dispatched forever just because it never wrote `failed`.
  it("hung attempts count toward the budget, like failures", () => {
    const task = taskWith(
      Array.from({ length: MAX_REVIEWER_ATTEMPTS }, (_, i) =>
        thread({
          title: "Reviewer: fix",
          status: "in_progress",
          createdAt: `2026-01-01T10:0${i + 1}:00Z`,
          lastActiveAt: "2026-01-01T09:30:00Z",
        }),
      ),
    );
    expect(reviewerHandledThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(
      true,
    );
    expect(reviewerAttemptsExhausted(task, "reviewer", CYCLE_START, NOW)).toBe(
      true,
    );
  });

  it("stops retrying once the cycle has spent MAX_REVIEWER_ATTEMPTS", () => {
    const task = taskWith(
      Array.from({ length: MAX_REVIEWER_ATTEMPTS }, (_, i) =>
        thread({
          title: "Reviewer: fix",
          status: "failed",
          createdAt: `2026-01-01T10:0${i + 1}:00Z`,
        }),
      ),
    );
    expect(reviewerHandledThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(
      true,
    );
    // …and says WHY: no verdict is coming, so the card needs a human.
    expect(reviewerAttemptsExhausted(task, "reviewer", CYCLE_START, NOW)).toBe(
      true,
    );
  });

  it("a completed review alongside a failed attempt is still handled", () => {
    const task = taskWith([
      thread({
        title: "Reviewer: fix",
        status: "failed",
        createdAt: "2026-01-01T10:01:00Z",
      }),
      thread({
        title: "Reviewer: fix",
        status: "completed",
        createdAt: "2026-01-01T10:06:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(
      true,
    );
  });

  // A retry must never run alongside a live attempt.
  it("a live attempt wins over a failed one", () => {
    const task = taskWith([
      thread({
        title: "Reviewer: fix",
        status: "failed",
        createdAt: "2026-01-01T10:01:00Z",
      }),
      thread({
        title: "Reviewer: fix",
        status: "in_progress",
        createdAt: "2026-01-01T10:06:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(
      true,
    );
  });

  it("a failure from a PRIOR cycle is not a spent attempt of this one", () => {
    const task = taskWith([
      thread({
        title: "Reviewer: fix",
        status: "failed",
        createdAt: "2026-01-01T09:30:00Z",
      }),
    ]);
    expect(spentAttemptsThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(0);
  });

  it("does not read the Super Agent's own thread as a review", () => {
    const task = taskWith([
      thread({
        title: "Super Agent: fix",
        status: "completed",
        createdAt: "2026-01-01T10:05:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(
      false,
    );
  });

  it("counts an in-flight run from the two-reviewer era as this cycle's review", () => {
    // Otherwise the deploy that merged the reviewers dispatches a second run
    // alongside one that is still going.
    const task = taskWith([
      thread({
        title: "Code Reviewer: fix",
        status: "in_progress",
        createdAt: "2026-01-01T10:05:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(
      true,
    );
  });
});

describe("a reviewer that completed without recording a verdict", () => {
  // OS-303 (osklen): the run finished while it was still "standing by" for a
  // background task, so it never called the decision tool. The card sat In
  // Review at 0/1 with nothing to move it — no re-dispatch, no hand-off.
  const completed = taskWith([
    thread({
      title: "Reviewer: fix",
      status: "completed",
      createdAt: "2026-01-01T10:05:00Z",
    }),
  ]);

  it("is not handled, and its attempt is spent, so it re-dispatches", () => {
    expect(
      reviewerHandledThisCycle(completed, "reviewer", CYCLE_START, NOW, false),
    ).toBe(false);
    expect(
      spentAttemptsThisCycle(completed, "reviewer", CYCLE_START, NOW, false),
    ).toBe(1);
    expect(
      reviewerAttemptsExhausted(completed, "reviewer", CYCLE_START, NOW, false),
    ).toBe(false);
  });

  it("is handled once the verdict is on the cycle's timeline", () => {
    expect(
      reviewerHandledThisCycle(completed, "reviewer", CYCLE_START, NOW, true),
    ).toBe(true);
    expect(
      spentAttemptsThisCycle(completed, "reviewer", CYCLE_START, NOW, true),
    ).toBe(0);
  });

  it("hands the card over once the budget is gone", () => {
    const twice = taskWith([
      thread({
        title: "Reviewer: fix",
        status: "completed",
        createdAt: "2026-01-01T10:05:00Z",
      }),
      thread({
        title: "Reviewer: fix",
        status: "completed",
        createdAt: "2026-01-01T10:07:00Z",
      }),
    ]);
    expect(
      reviewerAttemptsExhausted(twice, "reviewer", CYCLE_START, NOW, false),
    ).toBe(true);
  });
});

describe("the ask for a missing verdict", () => {
  const completed = taskWith([
    thread({
      title: "Reviewer: fix",
      status: "completed",
      createdAt: "2026-01-01T10:05:00Z",
    }),
  ]);
  const owedThreadId = completed.threads[0]!.threadId;

  it("names the completed thread that owes a verdict", () => {
    expect(
      undecidedReviewerThread(
        completed,
        "reviewer",
        CYCLE_START,
        new Map(),
        NOW,
      )?.threadId,
    ).toBe(owedThreadId);
  });

  it("asks each thread at most once", () => {
    const asked = new Map([[owedThreadId, NOW]]);
    expect(
      undecidedReviewerThread(completed, "reviewer", CYCLE_START, asked, NOW),
    ).toBeNull();
  });

  it("does not ask a failed or still-live run", () => {
    const dead = taskWith([
      thread({
        title: "Reviewer: fix",
        status: "failed",
        createdAt: "2026-01-01T10:05:00Z",
      }),
      thread({
        title: "Reviewer: fix",
        status: "in_progress",
        createdAt: "2026-01-01T10:06:00Z",
      }),
    ]);
    expect(
      undecidedReviewerThread(dead, "reviewer", CYCLE_START, new Map(), NOW),
    ).toBeNull();
  });

  it("reads the asks off the cycle's timeline, ignoring older ones", () => {
    const asked = verdictNudgedThreads(
      [
        {
          action: "review_verdict_requested",
          data: { threadId: "stale" },
          occurredAt: "2026-01-01T09:00:00Z",
        },
        {
          action: "review_verdict_requested",
          data: { threadId: owedThreadId },
          occurredAt: "2026-01-01T10:06:00Z",
        },
        {
          action: "status_changed",
          data: { to: "in_review" },
          occurredAt: "2026-01-01T10:00:00Z",
        },
      ],
      CYCLE_START,
    );
    expect([...asked.keys()]).toEqual([owedThreadId]);
  });

  it("holds the reviewer's attempts back only while an ask is fresh", () => {
    const at = new Date("2026-01-01T10:06:00Z").getTime();
    expect(awaitingVerdictNudge(new Map([["t", at]]), NOW)).toBe(true);
    expect(
      awaitingVerdictNudge(new Map([["t", at]]), at + 11 * 60 * 1000),
    ).toBe(false);
  });
});

describe("reviewerAttemptsExhausted", () => {
  const failed = (createdAt: string) =>
    thread({ title: "Reviewer: fix", status: "failed", createdAt });

  it("is false below the attempt budget", () => {
    const task = taskWith([failed("2026-01-01T10:01:00Z")]);
    expect(reviewerAttemptsExhausted(task, "reviewer", CYCLE_START, NOW)).toBe(
      false,
    );
  });

  // The distinction that matters: `reviewerHandledThisCycle` is also true for a
  // reviewer that ran fine, and that card must NOT be handed to a human.
  it("is false when a review actually completed", () => {
    const task = taskWith([
      failed("2026-01-01T10:01:00Z"),
      thread({
        title: "Reviewer: fix",
        status: "completed",
        createdAt: "2026-01-01T10:02:00Z",
      }),
    ]);
    expect(reviewerHandledThisCycle(task, "reviewer", CYCLE_START, NOW)).toBe(
      true,
    );
    expect(reviewerAttemptsExhausted(task, "reviewer", CYCLE_START, NOW)).toBe(
      false,
    );
  });

  it("is false while an attempt is still live", () => {
    const task = taskWith([
      failed("2026-01-01T10:01:00Z"),
      thread({
        title: "Reviewer: fix",
        status: "in_progress",
        createdAt: "2026-01-01T10:02:00Z",
      }),
    ]);
    expect(reviewerAttemptsExhausted(task, "reviewer", CYCLE_START, NOW)).toBe(
      false,
    );
  });

  it("ignores failures from a prior cycle", () => {
    const task = taskWith([
      failed("2026-01-01T09:00:00Z"),
      failed("2026-01-01T09:30:00Z"),
    ]);
    expect(reviewerAttemptsExhausted(task, "reviewer", CYCLE_START, NOW)).toBe(
      false,
    );
  });

  it("ignores the Super Agent's own failed run", () => {
    const task = taskWith([
      thread({
        title: "Super Agent: fix",
        status: "failed",
        createdAt: "2026-01-01T10:01:00Z",
      }),
      thread({
        title: "Super Agent: fix",
        status: "failed",
        createdAt: "2026-01-01T10:02:00Z",
      }),
    ]);
    expect(reviewerAttemptsExhausted(task, "reviewer", CYCLE_START, NOW)).toBe(
      false,
    );
  });
});

describe("pinnedRepoConnectionId", () => {
  const choice = {
    choices: [
      { connectionId: "conn_a", repo: "decocms/studio" },
      { connectionId: "conn_b", repo: "decocms/context" },
    ],
  };

  it("pins the id for the repo the card names", () => {
    expect(pinnedRepoConnectionId("decocms/studio", choice)).toBe("conn_a");
  });

  it("leaves the run to discover when the card names no repo", () => {
    expect(pinnedRepoConnectionId(null, choice)).toBeNull();
  });

  it("leaves the run to discover when the name matches nothing loadable", () => {
    expect(pinnedRepoConnectionId("decocms/gone", choice)).toBeNull();
  });

  it("has nothing to pin when the sole repo is already cloned", () => {
    const sole = { repo: { owner: "decocms", name: "studio" } };
    expect(
      pinnedRepoConnectionId(
        "decocms/studio",
        sole as unknown as Parameters<typeof pinnedRepoConnectionId>[1],
      ),
    ).toBeNull();
    expect(pinnedRepoConnectionId("decocms/studio", null)).toBeNull();
  });
});

describe("priorCycleReviewAt", () => {
  it("is 0 on a first review, so the prompt stays the plain one", () => {
    const task = taskWith([
      thread({
        title: "Reviewer: x",
        status: "in_progress",
        createdAt: "2026-01-01T10:01:00Z",
      }),
    ]);
    expect(priorCycleReviewAt(task, "reviewer", CYCLE_START)).toBe(0);
  });

  it("reports when this reviewer last ruled on an earlier cycle", () => {
    const task = taskWith([
      thread({
        title: "Reviewer: x",
        status: "completed",
        createdAt: "2026-01-01T08:00:00Z",
        lastActiveAt: "2026-01-01T08:30:00Z",
      }),
      thread({
        title: "Reviewer: x",
        status: "completed",
        createdAt: "2026-01-01T09:00:00Z",
        lastActiveAt: "2026-01-01T09:30:00Z",
      }),
    ]);
    // The most recent prior verdict, not the first.
    expect(priorCycleReviewAt(task, "reviewer", CYCLE_START)).toBe(
      new Date("2026-01-01T09:30:00Z").getTime(),
    );
  });

  it("does not read the Super Agent's prior run as a review", () => {
    const task = taskWith([
      thread({
        title: "Super Agent: x",
        status: "completed",
        createdAt: "2026-01-01T09:00:00Z",
        lastActiveAt: "2026-01-01T09:30:00Z",
      }),
    ]);
    expect(priorCycleReviewAt(task, "reviewer", CYCLE_START)).toBe(0);
  });

  it("does not count a failed attempt as a finished review", () => {
    const task = taskWith([
      thread({
        title: "Reviewer: x",
        status: "failed",
        createdAt: "2026-01-01T09:00:00Z",
        lastActiveAt: "2026-01-01T09:05:00Z",
      }),
    ]);
    // A failed run never read the PR, so this must stay a plain review.
    expect(priorCycleReviewAt(task, "reviewer", CYCLE_START)).toBe(0);
  });
});

describe("stalePreviewHandoffDue", () => {
  const cycle = Date.parse("2026-08-13T17:00:00.000Z");
  const at = (iso: string) => Date.parse(iso);

  it("waits out the grace — a deploy takes minutes", () => {
    expect(stalePreviewHandoffDue(cycle, at("2026-08-13T17:20:00.000Z"))).toBe(
      false,
    );
  });

  it("hands over once the preview is clearly never arriving", () => {
    expect(stalePreviewHandoffDue(cycle, at("2026-08-13T17:30:00.000Z"))).toBe(
      true,
    );
    expect(stalePreviewHandoffDue(cycle, at("2026-08-13T19:00:00.000Z"))).toBe(
      true,
    );
  });

  it("treats a card with no recorded cycle start as infinitely old", () => {
    expect(stalePreviewHandoffDue(0, at("2026-08-13T17:00:00.000Z"))).toBe(
      true,
    );
  });
});

describe("authorRunLive", () => {
  it("is true while the Super Agent's own thread is still running", () => {
    const task = taskWith([
      thread({
        title: "Super Agent: fix",
        status: "in_progress",
        createdAt: "2026-01-01T10:00:00Z",
        lastActiveAt: "2026-01-01T10:09:00Z",
      }),
    ]);
    expect(authorRunLive(task, NOW)).toBe(true);
  });

  it("is false once the Super Agent's thread is terminal", () => {
    const task = taskWith([
      thread({
        title: "Super Agent: fix",
        status: "completed",
        createdAt: "2026-01-01T10:00:00Z",
        lastActiveAt: "2026-01-01T10:09:00Z",
      }),
    ]);
    expect(authorRunLive(task, NOW)).toBe(false);
  });

  it("is false for an author that went silent — a dead run must not strand the card", () => {
    const task = taskWith([
      thread({
        title: "Super Agent: fix",
        status: "in_progress",
        createdAt: "2026-01-01T08:00:00Z",
        lastActiveAt: "2026-01-01T08:00:00Z",
      }),
    ]);
    expect(authorRunLive(task, NOW)).toBe(false);
  });

  it("does not count a live reviewer thread as the author", () => {
    const task = taskWith([
      thread({
        title: "Reviewer: fix",
        status: "in_progress",
        createdAt: "2026-01-01T10:00:00Z",
        lastActiveAt: "2026-01-01T10:09:00Z",
      }),
    ]);
    expect(authorRunLive(task, NOW)).toBe(false);
  });
});
