import { describe, expect, test } from "bun:test";
import { buildProjectIndex } from "@/lib/project-index";
import {
  attentionReason,
  costSeriesForProjectMonthToDate,
  costSeriesMonthToDate,
  dailyPulse,
  monthlyCost,
  projectSummaries,
  runningAgents,
  runsSeries,
  runsToday,
  shippedSeries,
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
    status: "todo",
    assigneeId: null,
    createdAt: daysAgo(0),
    updatedAt: daysAgo(0),
    threads: [],
    repo: null,
    ...over,
  }) as never;

describe("dailyPulse", () => {
  test("counts done and merged inside the window as shipped", () => {
    const pulse = dailyPulse(
      [
        task({ status: "done", updatedAt: daysAgo(1) }),
        task({ status: "merged", updatedAt: daysAgo(6) }),
      ],
      NOW,
    );
    expect(pulse.shipped).toBe(2);
  });

  test("does not count what shipped before the window", () => {
    expect(
      dailyPulse([task({ status: "done", updatedAt: daysAgo(8) })], NOW)
        .shipped,
    ).toBe(0);
  });

  test("an archived card did not ship", () => {
    expect(
      dailyPulse([task({ status: "archived", updatedAt: daysAgo(1) })], NOW)
        .shipped,
    ).toBe(0);
  });

  test("a card is counted once however many runs it has", () => {
    const pulse = dailyPulse(
      [
        task({
          threads: [thread("failed", daysAgo(1)), thread("failed", daysAgo(2))],
        }),
      ],
      NOW,
    );
    expect(pulse.failed).toBe(1);
  });

  test("failures are counted only inside the window", () => {
    const pulse = dailyPulse(
      [
        task({ threads: [thread("failed", daysAgo(2))] }),
        task({ threads: [thread("failed", daysAgo(30))] }),
      ],
      NOW,
    );
    expect(pulse.failed).toBe(1);
  });

  test("an unparseable timestamp never counts", () => {
    expect(
      dailyPulse([task({ status: "done", updatedAt: "not a date" })], NOW)
        .shipped,
    ).toBe(0);
  });
});

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
        task({ id: "merged", status: "merged", assigneeId: "user_1" }),
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

describe("projectSummaries", () => {
  const project = (id: string, repo: string | null) =>
    ({
      id,
      title: id,
      created_at: "2026-01-01T00:00:00Z",
      metadata: repo
        ? {
            githubRepo: {
              owner: repo.split("/")[0],
              name: repo.split("/")[1],
              url: `https://github.com/${repo}`,
            },
          }
        : {},
      connections: [],
    }) as never;

  test("counts only what is still open", () => {
    const index = buildProjectIndex([project("p1", "deco/farm")]);
    const summaries = projectSummaries(
      index,
      [
        task({ status: "todo", repo: "deco/farm" }),
        task({ status: "in_progress", repo: "deco/farm" }),
        task({ status: "merged", repo: "deco/farm" }),
        task({ status: "done", repo: "deco/farm" }),
      ],
      undefined,
      NOW,
    );
    expect(summaries.get("p1")?.open).toBe(2);
  });

  test("a card on a shared repository counts for every project pinning it", () => {
    const index = buildProjectIndex([
      project("p1", "deco/mono"),
      project("p2", "deco/mono"),
    ]);
    const summaries = projectSummaries(
      index,
      [task({ status: "todo", repo: "deco/mono" })],
      undefined,
      NOW,
    );
    expect(summaries.get("p1")?.open).toBe(1);
    expect(summaries.get("p2")?.open).toBe(1);
  });

  test("a repo-less project is reached through its runs", () => {
    const index = buildProjectIndex([project("p1", null)]);
    const summaries = projectSummaries(
      index,
      [task({ status: "todo", threads: [{ virtualMcpId: "p1" }] })],
      undefined,
      NOW,
    );
    expect(summaries.get("p1")?.open).toBe(1);
  });

  /** The ranking IS the feature: a row that says "shipped" while a run is
   *  stopped on an answer is a row that cost someone their morning. */
  test("something stopped on you outranks everything else", () => {
    const index = buildProjectIndex([project("p1", "deco/farm")]);
    const summaries = projectSummaries(
      index,
      [
        task({ status: "done", updatedAt: daysAgo(1), repo: "deco/farm" }),
        task({
          status: "todo",
          repo: "deco/farm",
          threads: [thread("failed")],
        }),
        task({ status: "in_review", repo: "deco/farm" }),
      ],
      undefined,
      NOW,
    );
    expect(summaries.get("p1")?.kind).toBe("waiting");
  });

  test("a break outranks a delivery", () => {
    const index = buildProjectIndex([project("p1", "deco/farm")]);
    const summaries = projectSummaries(
      index,
      [
        task({ status: "done", updatedAt: daysAgo(1), repo: "deco/farm" }),
        task({
          status: "in_progress",
          repo: "deco/farm",
          threads: [thread("failed")],
        }),
      ],
      undefined,
      NOW,
    );
    expect(summaries.get("p1")?.kind).toBe("failed");
  });

  test("an open queue and nothing else is not news", () => {
    const index = buildProjectIndex([project("p1", "deco/farm")]);
    const summaries = projectSummaries(
      index,
      [task({ status: "todo", repo: "deco/farm" })],
      undefined,
      NOW,
    );
    expect(summaries.get("p1")).toMatchObject({ kind: "open", count: 1 });
  });

  test("a project nothing touched has no row headline at all", () => {
    const index = buildProjectIndex([project("p1", "deco/farm")]);
    expect(projectSummaries(index, [], undefined, NOW).get("p1")).toBe(
      undefined,
    );
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
  const project = {
    id: "p1",
    title: "p1",
    created_at: "2026-01-01T00:00:00Z",
    metadata: {
      githubRepo: {
        owner: "deco",
        name: "farm",
        url: "https://github.com/deco/farm",
      },
    },
    connections: [],
  } as never;

  test("buckets by day, oldest first", () => {
    const index = buildProjectIndex([project]);
    const series = shippedSeries(
      index,
      [
        task({ status: "done", updatedAt: daysAgo(0), repo: "deco/farm" }),
        task({ status: "merged", updatedAt: daysAgo(0), repo: "deco/farm" }),
        task({ status: "done", updatedAt: daysAgo(3), repo: "deco/farm" }),
      ],
      "p1",
      7,
      NOW,
    );
    expect(series).toEqual([0, 0, 0, 1, 0, 0, 2]);
  });

  test("another project's work is not in this project's line", () => {
    const index = buildProjectIndex([project]);
    const series = shippedSeries(
      index,
      [task({ status: "done", updatedAt: daysAgo(0), repo: "deco/other" })],
      "p1",
      7,
      NOW,
    );
    expect(series).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  /** Older than the window falls out rather than piling onto day zero. */
  test("work older than the window is not in the line", () => {
    const index = buildProjectIndex([project]);
    const series = shippedSeries(
      index,
      [task({ status: "done", updatedAt: daysAgo(30), repo: "deco/farm" })],
      "p1",
      7,
      NOW,
    );
    expect(series.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe("runsToday", () => {
  const AT_NOON = Date.parse("2026-09-22T12:00:00Z");
  const todayAt = (hour: number) =>
    new Date(new Date(AT_NOON).setHours(hour, 0, 0, 0)).toISOString();

  test("counts the runs touched since midnight", () => {
    expect(
      runsToday(
        [
          task({ threads: [thread("completed", todayAt(9))] }),
          task({ threads: [thread("completed", daysAgo(2))] }),
        ],
        AT_NOON,
      ).runs,
    ).toBe(1);
  });

  /** Live is a state, not a window: a run started yesterday and still going is
   *  the one most worth knowing about. */
  test("live counts what is still in progress whenever it started", () => {
    expect(
      runsToday([task({ threads: [thread("in_progress", daysAgo(3))] })], NOW)
        .live,
    ).toBe(1);
  });

  test("an unparseable timestamp is not today", () => {
    expect(
      runsToday([task({ threads: [thread("completed", "not a date")] })], NOW)
        .runs,
    ).toBe(0);
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

describe("monthlyCost", () => {
  const project = (id: string, repo: string) =>
    ({
      id,
      title: id,
      created_at: "2026-01-01T00:00:00Z",
      metadata: {
        githubRepo: {
          owner: repo.split("/")[0],
          name: repo.split("/")[1],
          url: `https://github.com/${repo}`,
        },
      },
      connections: [],
    }) as never;
  const index = buildProjectIndex([
    project("p1", "deco/farm"),
    project("p2", "deco/osklen"),
  ]);
  /** Mid-month, so "since the 1st" and "last 7 days" cannot be confused. */
  const MID = Date.parse("2026-09-20T12:00:00Z");
  const onDay = (day: number) =>
    new Date(
      Date.parse(`2026-09-${String(day).padStart(2, "0")}T10:00:00Z`),
    ).toISOString();

  test("totals the month and ranks the projects that spent it", () => {
    const cost = monthlyCost(
      index,
      [
        task({
          repo: "deco/farm",
          threads: [thread("completed", onDay(3), { costUsd: 2 })],
        }),
        task({
          repo: "deco/osklen",
          threads: [thread("completed", onDay(9), { costUsd: 5 })],
        }),
      ],
      MID,
    );
    expect(cost.total).toBe(7);
    expect(cost.byProject).toEqual([
      { projectId: "p2", usd: 5 },
      { projectId: "p1", usd: 2 },
    ]);
  });

  /** Calendar month, not a rolling window: a bill arrives per month. */
  test("last month's spend is not on this month's total", () => {
    expect(
      monthlyCost(
        index,
        [
          task({
            repo: "deco/farm",
            threads: [
              thread("completed", "2026-08-28T10:00:00Z", { costUsd: 9 }),
            ],
          }),
        ],
        MID,
      ).total,
    ).toBe(0);
  });

  test("a project that spent nothing is not in the ranking", () => {
    expect(
      monthlyCost(
        index,
        [task({ repo: "deco/farm", threads: [thread("completed", onDay(3))] })],
        MID,
      ).byProject,
    ).toEqual([]);
  });

  /** A ratio with a zero denominator is not a number anyone should read. */
  test("cost per shipped card is null when nothing shipped", () => {
    expect(
      monthlyCost(
        index,
        [
          task({
            repo: "deco/farm",
            threads: [thread("completed", onDay(3), { costUsd: 4 })],
          }),
        ],
        MID,
      ).perShipped,
    ).toBe(null);
  });

  test("cost per shipped card divides by what actually shipped", () => {
    const cost = monthlyCost(
      index,
      [
        task({
          status: "done",
          repo: "deco/farm",
          updatedAt: onDay(5),
          threads: [thread("completed", onDay(5), { costUsd: 6 })],
        }),
        task({
          status: "merged",
          repo: "deco/farm",
          updatedAt: onDay(6),
          threads: [thread("completed", onDay(6), { costUsd: 4 })],
        }),
      ],
      MID,
    );
    expect(cost.perShipped).toBe(5);
  });

  /** Same window as the total above — a "this month" headline and its chart
   *  must never quietly disagree on what window they're both claiming. */
  test("costSeriesMonthToDate buckets spend by calendar day since the 1st", () => {
    expect(
      costSeriesMonthToDate(
        [
          task({
            repo: "deco/farm",
            threads: [thread("completed", onDay(1), { costUsd: 2 })],
          }),
          task({
            repo: "deco/osklen",
            threads: [thread("completed", onDay(20), { costUsd: 5 })],
          }),
        ],
        MID,
      ),
    ).toEqual([2, ...new Array(18).fill(0), 5]);
  });

  test("costSeriesMonthToDate drops last month's spend, not clamped into day one", () => {
    const series = costSeriesMonthToDate(
      [
        task({
          repo: "deco/farm",
          threads: [
            thread("completed", "2026-08-28T10:00:00Z", { costUsd: 9 }),
          ],
        }),
      ],
      MID,
    );
    expect(series.reduce((sum, day) => sum + day, 0)).toBe(0);
  });

  test("costSeriesForProjectMonthToDate scopes the series to one project", () => {
    const series = costSeriesForProjectMonthToDate(
      index,
      [
        task({
          repo: "deco/farm",
          threads: [thread("completed", onDay(3), { costUsd: 2 })],
        }),
        task({
          repo: "deco/osklen",
          threads: [thread("completed", onDay(3), { costUsd: 5 })],
        }),
      ],
      "p1",
      MID,
    );
    expect(series[2]).toBe(2);
    expect(series.reduce((sum, day) => sum + day, 0)).toBe(2);
  });
});
