import { describe, expect, it } from "bun:test";
import { compactElapsed, feedRail } from "./feed-rail";
import type { TaskBoardItem } from "./config";

const task = (over: Partial<TaskBoardItem> = {}): TaskBoardItem =>
  ({
    id: "t-1",
    title: "A task",
    status: "todo",
    priority: "none",
    assigneeId: null,
    threads: [],
    tags: [],
    createdAt: "2026-09-23T09:00:00Z",
    updatedAt: "2026-09-23T09:00:00Z",
    ...over,
  }) as unknown as TaskBoardItem;

const thread = (over: Record<string, unknown>) =>
  ({
    status: null,
    failureKind: null,
    createdAt: "2026-09-23T09:00:00Z",
    lastActiveAt: "2026-09-23T09:00:00Z",
    ...over,
  }) as TaskBoardItem["threads"][number];

describe("feedRail", () => {
  it("lists live runs, most recently active first", () => {
    const rail = feedRail([
      task({
        id: "quiet",
        threads: [
          thread({
            status: "in_progress",
            lastActiveAt: "2026-09-23T09:00:00Z",
          }),
        ],
      }),
      task({
        id: "busy",
        threads: [
          thread({
            status: "in_progress",
            lastActiveAt: "2026-09-23T10:00:00Z",
          }),
        ],
      }),
    ]);
    expect(rail.running.map((r) => r.item.id)).toEqual(["busy", "quiet"]);
  });

  it("ignores a superseded attempt when picking the live run", () => {
    const rail = feedRail([
      task({
        threads: [
          thread({ status: "in_progress", failureKind: "superseded" }),
          thread({ status: "completed" }),
        ],
      }),
    ]);
    expect(rail.running).toEqual([]);
  });

  it("counts a card waiting on an answer, and one handed back", () => {
    const rail = feedRail([
      task({ id: "asked", threads: [thread({ status: "requires_action" })] }),
      task({ id: "handed", status: "in_review", assigneeId: null }),
      task({ id: "owned", status: "in_review", assigneeId: "u-1" }),
    ]);
    expect(rail.waiting.map((i) => i.id).sort()).toEqual(["asked", "handed"]);
  });

  it("puts a card with a live run in running only, never in both", () => {
    const rail = feedRail([
      task({
        id: "both",
        threads: [
          thread({ status: "requires_action" }),
          thread({ status: "in_progress" }),
        ],
      }),
    ]);
    expect(rail.running.map((r) => r.item.id)).toEqual(["both"]);
    expect(rail.waiting).toEqual([]);
  });

  it("keeps the true totals when the lists are cut", () => {
    const rail = feedRail(
      Array.from({ length: 8 }, (_, i) =>
        task({ id: `t-${i}`, threads: [thread({ status: "in_progress" })] }),
      ),
    );
    expect(rail.running).toHaveLength(5);
    expect(rail.runningTotal).toBe(8);
  });
});

describe("compactElapsed", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");

  it("reads a run that just started as now", () => {
    expect(compactElapsed("2026-09-23T11:59:30Z", now)).toBe("now");
  });

  it("clamps a timestamp from a clock running ahead", () => {
    expect(compactElapsed("2026-09-23T12:05:00Z", now)).toBe("now");
  });

  it("steps up through minutes, hours and days", () => {
    expect(compactElapsed("2026-09-23T11:45:00Z", now)).toBe("15m");
    expect(compactElapsed("2026-09-23T09:00:00Z", now)).toBe("3h");
    expect(compactElapsed("2026-09-21T12:00:00Z", now)).toBe("2d");
  });

  it("says nothing about an unparseable timestamp", () => {
    expect(compactElapsed("not a date", now)).toBe("");
  });
});
