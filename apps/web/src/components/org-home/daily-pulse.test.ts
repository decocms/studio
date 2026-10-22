import { describe, expect, test } from "bun:test";
import {
  attentionReason,
  costSeriesMonthToDate,
  runningAgents,
  runsSeries,
  shippedSeries,
  shippedSince,
  tasksNeedingMe,
} from "./daily-pulse.ts";

const NOW = Date.parse("2026-09-22T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const thread = (
  status: string | null,
  lastActiveAt = daysAgo(0),
  over: Record<string, unknown> = {},
) =>
  ({
    threadId: "t",
    status,
    lastActiveAt,
    createdAt: lastActiveAt,
    costUsd: null,
    ...over,
  }) as never;

const task = (over: Record<string, unknown> = {}) =>
  ({
    id: "task",
    status: "triage",
    assigneeId: null,
    createdAt: daysAgo(0),
    updatedAt: daysAgo(0),
    threads: [],
    repo: null,
    ...over,
  }) as never;

describe("tasksNeedingMe", () => {
  test("a run asking a question is waiting on a person", () => {
    const list = tasksNeedingMe(
      [task({ id: "ask", threads: [thread("requires_action")] })],
      "user_1",
    );
    expect(list.map((t) => t.id)).toEqual(["ask"]);
  });

  test("an unowned card in review is a hand-off nobody caught", () => {
    const list = tasksNeedingMe(
      [task({ id: "handoff", status: "in_review", assigneeId: null })],
      "user_1",
    );
    expect(list.map((t) => t.id)).toEqual(["handoff"]);
  });

  test("a card assigned to me counts, one assigned to someone else does not", () => {
    const list = tasksNeedingMe(
      [
        task({ id: "mine", assigneeId: "user_1" }),
        task({ id: "theirs", assigneeId: "user_2" }),
      ],
      "user_1",
    );
    expect(list.map((t) => t.id)).toEqual(["mine"]);
  });

  test("a closed card never asks for anything", () => {
    const list = tasksNeedingMe(
      [
        task({ id: "done", status: "done", assigneeId: "user_1" }),
        task({ id: "archived", status: "archived", assigneeId: "user_1" }),
      ],
      "user_1",
    );
    expect(list).toEqual([]);
  });

  /** Inverted when the queue became oldest-first: the longest-waiting card is
   *  the one most likely to have been forgotten, and newest-first buried it. */
  test("longest waiting first", () => {
    const list = tasksNeedingMe(
      [
        task({ id: "old", assigneeId: "user_1", updatedAt: daysAgo(3) }),
        task({ id: "new", assigneeId: "user_1", updatedAt: daysAgo(1) }),
      ],
      "user_1",
    );
    expect(list.map((t) => t.id)).toEqual(["old", "new"]);
  });
});

describe("attentionReason", () => {
  test("a question outranks the lane it is parked in", () => {
    expect(
      attentionReason(
        task({ status: "in_review", threads: [thread("requires_action")] }),
      ),
    ).toBe("answer");
  });

  test("an unowned review card reads as a review", () => {
    expect(attentionReason(task({ status: "in_review" }))).toBe("review");
  });

  test("everything else is here because it is mine", () => {
    expect(attentionReason(task({ assigneeId: "user_1" }))).toBe("assigned");
  });
});

describe("runningAgents", () => {
  test("only the runs still going, newest first", () => {
    const running = runningAgents([
      task({
        id: "a",
        title: "A",
        threads: [
          thread("in_progress", daysAgo(2), { threadId: "t1" }),
          thread("completed", daysAgo(0), { threadId: "t2" }),
        ],
      }),
      task({
        id: "b",
        title: "B",
        threads: [thread("in_progress", daysAgo(1), { threadId: "t3" })],
      }),
    ]);
    expect(running.map((r) => r.threadId)).toEqual(["t3", "t1"]);
  });

  test("nothing running is an empty list, not a null", () => {
    expect(runningAgents([task({ threads: [] })])).toEqual([]);
  });
});

describe("shippedSeries", () => {
  test("buckets by day, oldest first", () => {
    const series = shippedSeries(
      [
        task({ status: "done", updatedAt: daysAgo(0) }),
        task({ status: "done", updatedAt: daysAgo(0) }),
        task({ status: "done", updatedAt: daysAgo(3) }),
        task({ status: "in_progress", updatedAt: daysAgo(1) }),
      ],
      7,
      NOW,
    );
    expect(series).toEqual([0, 0, 0, 1, 0, 0, 2]);
  });

  /** Older than the window falls out rather than piling onto day zero. */
  test("work older than the window is not in the line", () => {
    const series = shippedSeries(
      [task({ status: "done", updatedAt: daysAgo(30) })],
      7,
      NOW,
    );
    expect(series.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe("runsSeries", () => {
  test("buckets runs by day, oldest first", () => {
    expect(
      runsSeries(
        [
          task({
            threads: [
              thread("completed", daysAgo(0)),
              thread("completed", daysAgo(0)),
              thread("failed", daysAgo(2)),
            ],
          }),
        ],
        4,
        NOW,
      ),
    ).toEqual([0, 1, 0, 2]);
  });

  test("runs older than the window fall out rather than piling on day zero", () => {
    expect(
      runsSeries(
        [task({ threads: [thread("completed", daysAgo(40))] })],
        4,
        NOW,
      ).reduce((a, b) => a + b, 0),
    ).toBe(0);
  });
});

describe("costSeriesMonthToDate", () => {
  /** Mid-month, so "since the 1st" and "last 7 days" cannot be confused. */
  const MID = Date.parse("2026-09-20T12:00:00Z");
  const onDay = (day: number) =>
    new Date(
      Date.parse(`2026-09-${String(day).padStart(2, "0")}T10:00:00Z`),
    ).toISOString();

  test("buckets dollars by day since the 1st, last month excluded", () => {
    const series = costSeriesMonthToDate(
      [
        task({
          threads: [
            thread("completed", onDay(3), { costUsd: 2 }),
            thread("completed", "2026-08-30T10:00:00Z", { costUsd: 9 }),
          ],
        }),
        task({ threads: [thread("completed", onDay(3), { costUsd: 5 })] }),
      ],
      MID,
    );
    expect(series).toHaveLength(20);
    expect(series[2]).toBe(7);
    expect(series.reduce((sum, day) => sum + day, 0)).toBe(7);
  });
});

describe("shippedSince", () => {
  const since = NOW - 86_400_000;

  test("counts merged work at or after the window start", () => {
    expect(
      shippedSince(
        [
          task({ status: "done", updatedAt: daysAgo(0.5) }),
          task({ status: "post_deploy_validation", updatedAt: daysAgo(0.5) }),
          task({ status: "done", updatedAt: new Date(since).toISOString() }),
        ],
        since,
      ),
    ).toBe(3);
  });

  test("a card waiting on QA or its release has not shipped", () => {
    expect(
      shippedSince(
        [
          task({ status: "qa", updatedAt: daysAgo(0.5) }),
          task({ status: "ready_for_deployment", updatedAt: daysAgo(0.5) }),
        ],
        since,
      ),
    ).toBe(0);
  });

  test("does not count what shipped before the window", () => {
    expect(
      shippedSince([task({ status: "done", updatedAt: daysAgo(2) })], since),
    ).toBe(0);
  });

  test("an archived card did not ship", () => {
    expect(
      shippedSince(
        [task({ status: "archived", updatedAt: daysAgo(0.5) })],
        since,
      ),
    ).toBe(0);
  });

  test("an unparseable or missing timestamp never counts", () => {
    expect(
      shippedSince(
        [
          task({ status: "done", updatedAt: "not a date" }),
          task({ status: "done", updatedAt: null }),
        ],
        since,
      ),
    ).toBe(0);
  });
});
