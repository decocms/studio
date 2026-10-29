import { describe, expect, test } from "bun:test";
import type { TaskBoardItem } from "@/layouts/task-board/config";
import type { InboxTaskUpdate } from "@/hooks/use-inbox-feed";
import { forYouItems, niceMax, queueRows } from "./home-overview";

describe("niceMax", () => {
  test("rounds the peak up to a whole step", () => {
    expect(niceMax(3)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(18)).toBe(20);
    expect(niceMax(0.43)).toBe(0.5);
  });

  test("keeps a peak that already is one", () => {
    expect(niceMax(20)).toBe(20);
  });

  test("gives an empty series a scale to draw on", () => {
    expect(niceMax(0)).toBe(1);
  });
});

const card = (id: string, threadStatus?: string) =>
  ({
    id,
    status: "in_progress",
    threads: threadStatus ? [{ status: threadStatus }] : [],
  }) as unknown as TaskBoardItem;

describe("queueRows", () => {
  test("lists each card once, a dead run before a live one", () => {
    const running = card("running", "in_progress");
    const failed = card("failed", "failed");
    const rows = queueRows([], [running, failed, running]);
    expect(rows.map((r) => [r.task.id, r.kind])).toEqual([
      ["failed", "failed"],
      ["running", "running"],
    ]);
  });

  test("skips closed cards even when their last run failed", () => {
    const done = { ...card("done", "failed"), status: "done" } as TaskBoardItem;
    const archived = {
      ...card("archived", "in_progress"),
      status: "archived",
    } as TaskBoardItem;
    expect(queueRows([], [done, archived])).toEqual([]);
  });
});

const update = (
  id: string,
  taskBoardItemId: string,
  action: "mentioned" | "commented" | "assigned",
) =>
  ({
    id,
    taskBoardItemId,
    action,
    taskTitle: taskBoardItemId,
    taskKeySeq: 1,
    actorName: "Ana",
    occurredAt: "2026-10-20T00:00:00Z",
  }) as InboxTaskUpdate;

describe("forYouItems", () => {
  test("folds a card's mention into its queue row", () => {
    const review = card("review");
    const items = forYouItems(
      [{ task: review, kind: "review" }],
      [update("u1", "review", "commented")],
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.mention?.id).toBe("u1");
  });

  test("keeps one row per card, a mention beating a comment", () => {
    const items = forYouItems(
      [],
      [
        update("c1", "other", "commented"),
        update("m1", "other", "mentioned"),
        update("c2", "other", "commented"),
      ],
    );
    expect(items.map((item) => item.mention?.id)).toEqual(["m1"]);
  });

  test("puts loose mentions after questions and before the rest", () => {
    const answer = card("answer");
    const running = card("running");
    const items = forYouItems(
      [
        { task: answer, kind: "answer" },
        { task: running, kind: "running" },
      ],
      [update("m1", "loose", "mentioned"), update("a1", "x", "assigned")],
    );
    expect(items.map((item) => item.kind)).toEqual([
      "answer",
      "mention",
      "running",
    ]);
  });
});
