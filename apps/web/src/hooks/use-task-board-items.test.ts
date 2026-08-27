import { describe, expect, it } from "bun:test";
import { mergeLiveItems } from "./use-task-board-items";

type Item = Parameters<typeof mergeLiveItems>[0][number];

const item = (id: string, status: string, updatedAt: string) =>
  ({ id, status, updatedAt }) as unknown as Item;

describe("mergeLiveItems", () => {
  it("keeps the SSE-pushed card when the refetch answers with an older row", () => {
    const live = new Map([
      ["a", item("a", "in_progress", "2026-01-01T00:00:01Z")],
    ]);
    const merged = mergeLiveItems(
      [item("a", "todo", "2026-01-01T00:00:00Z")],
      live,
    );
    expect(merged[0]!.status).toBe("in_progress");
    // Still in flight as far as the server is concerned — keep guarding it.
    expect(live.size).toBe(1);
  });

  it("takes the server row once it has caught up, and forgets the live copy", () => {
    const live = new Map([
      ["a", item("a", "in_progress", "2026-01-01T00:00:01Z")],
    ]);
    const merged = mergeLiveItems(
      [item("a", "in_review", "2026-01-01T00:00:02Z")],
      live,
    );
    expect(merged[0]!.status).toBe("in_review");
    expect(live.size).toBe(0);
  });

  it("leaves untracked cards alone", () => {
    const items = [item("b", "todo", "2026-01-01T00:00:00Z")];
    expect(mergeLiveItems(items, new Map())).toBe(items);
  });
});
