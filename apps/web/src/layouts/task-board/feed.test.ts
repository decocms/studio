import { describe, expect, it } from "bun:test";
import { feedEventKind, groupFeedByDay } from "./feed";
import type { TaskBoardItem } from "./config";

/** The fields the feed actually reads; everything else is board furniture. */
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
    ...over,
  }) as TaskBoardItem["threads"][number];

describe("feedEventKind", () => {
  it("reads a fresh card as created", () => {
    expect(feedEventKind(task())).toBe("created");
  });

  it("reads a card touched later as updated", () => {
    expect(feedEventKind(task({ updatedAt: "2026-09-23T11:00:00Z" }))).toBe(
      "updated",
    );
  });

  it("puts a card waiting on a person above everything it is also doing", () => {
    expect(
      feedEventKind(
        task({
          status: "in_review",
          threads: [
            thread({ status: "requires_action" }),
            thread({ status: "in_progress" }),
          ],
        }),
      ),
    ).toBe("blocked");
  });

  it("reads a live run as running even when another attempt failed", () => {
    expect(
      feedEventKind(
        task({
          threads: [
            thread({ status: "failed" }),
            thread({ status: "in_progress" }),
          ],
        }),
      ),
    ).toBe("running");
  });

  it("names the lane when nothing is running", () => {
    expect(feedEventKind(task({ status: "done" }))).toBe("done");
    expect(
      feedEventKind(task({ status: "in_review", assigneeId: "user-1" })),
    ).toBe("review");
  });

  it("names a delivery lane as its own event, not a plain edit", () => {
    expect(
      feedEventKind(
        task({ status: "merged", updatedAt: "2026-09-25T09:00:00Z" }),
      ),
    ).toBe("delivered");
  });

  it("calls an unassigned card parked in review a hand-off", () => {
    expect(feedEventKind(task({ status: "in_review" }))).toBe("handed");
  });
});

describe("groupFeedByDay", () => {
  const now = new Date("2026-09-23T12:00:00");

  it("orders newest first, across and within days", () => {
    const days = groupFeedByDay(
      [
        task({ id: "old", updatedAt: "2026-09-21T08:00:00" }),
        task({ id: "newest", updatedAt: "2026-09-23T11:00:00" }),
        task({ id: "earlier-today", updatedAt: "2026-09-23T07:00:00" }),
      ],
      now,
    );
    expect(days.map((d) => d.items.map((i) => i.id))).toEqual([
      ["newest", "earlier-today"],
      ["old"],
    ]);
  });

  it("names today and yesterday, and nothing older", () => {
    const days = groupFeedByDay(
      [
        task({ id: "a", updatedAt: "2026-09-23T07:00:00" }),
        task({ id: "b", updatedAt: "2026-09-22T07:00:00" }),
        task({ id: "c", updatedAt: "2026-09-20T07:00:00" }),
      ],
      now,
    );
    expect(days.map((d) => d.relative)).toEqual(["today", "yesterday", null]);
  });

  it("groups by the local day, not the UTC one", () => {
    /** 23:30 local is already tomorrow in UTC east of Greenwich, so an
     *  ISO-string key would file this under a day that has not happened. */
    const late = new Date(2026, 8, 23, 23, 30);
    const days = groupFeedByDay([task({ updatedAt: late.toISOString() })], now);
    expect(days).toHaveLength(1);
    expect(days[0]!.relative).toBe("today");
  });

  it("drops a card whose timestamp cannot be read", () => {
    expect(groupFeedByDay([task({ updatedAt: "not a date" })], now)).toEqual(
      [],
    );
  });
});
