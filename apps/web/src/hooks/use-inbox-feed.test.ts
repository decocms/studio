import { describe, expect, it } from "bun:test";
import { dropLocally } from "./use-inbox-feed";

type Page = Parameters<typeof dropLocally>[0] extends
  | { pages: (infer P)[] }
  | undefined
  ? P
  : never;

const page = (ids: string[], unreadCount: number) =>
  ({
    notifications: ids.map((id) => ({ id })),
    unreadCount,
    nextCursor: null,
  }) as unknown as Page;

const data = (pages: Page[]) => ({ pages, pageParams: pages.map(() => null) });

describe("dropLocally", () => {
  it("removes one row and decrements the count", () => {
    const out = dropLocally(data([page(["a", "b"], 2)]), ["a"])!;
    expect(out.pages[0]!.notifications.map((n) => n.id)).toEqual(["b"]);
    expect(out.pages[0]!.unreadCount).toBe(1);
  });

  it("decrements once per row actually removed, so a repeat can't go negative", () => {
    const first = dropLocally(data([page(["a"], 1)]), ["a"])!;
    const second = dropLocally(first, ["a"])!;
    expect(second.pages[0]!.unreadCount).toBe(0);
  });

  it("clears every loaded page and zeroes the count for mark-all-read", () => {
    const out = dropLocally(data([page(["a"], 3), page(["b", "c"], 3)]), null)!;
    expect(out.pages.flatMap((p) => p.notifications)).toEqual([]);
    expect(out.pages.every((p) => p.unreadCount === 0)).toBe(true);
  });
});
