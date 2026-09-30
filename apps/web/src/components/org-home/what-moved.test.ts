import { describe, expect, test } from "bun:test";
import { derivedMove } from "./what-moved";
import type { TaskBoardItem } from "@/layouts/task-board/config";

/** Only the fields `derivedMove` reads — the rest of a board item is noise here. */
const task = (
  over: Partial<TaskBoardItem> & { updatedAt: string },
): TaskBoardItem =>
  ({
    title: "t",
    status: "todo",
    threads: [],
    ...over,
  }) as unknown as TaskBoardItem;

describe("derivedMove", () => {
  test("a project with nothing to report has no reading", () => {
    expect(derivedMove([])).toBeNull();
    expect(derivedMove([task({ updatedAt: "2026-01-01" })])).toBeNull();
  });

  /** A break outranks a delivery: something that shipped is good news you can
   *  read later, something that failed is why you opened the page. */
  test("a failure outranks a newer delivery", () => {
    const moved = derivedMove([
      task({
        updatedAt: "2026-01-01",
        title: "broke",
        threads: [{ status: "failed" }] as TaskBoardItem["threads"],
      }),
      task({ updatedAt: "2026-02-01", title: "shipped", status: "done" }),
    ]);
    expect(moved?.kind).toBe("failed");
    expect(moved?.title).toBe("broke");
  });

  test("reports the newest delivery when nothing broke", () => {
    const moved = derivedMove([
      task({ updatedAt: "2026-01-01", title: "older", status: "done" }),
      task({ updatedAt: "2026-03-01", title: "newest", status: "merged" }),
    ]);
    expect(moved).toMatchObject({ kind: "shipped", title: "newest", more: 1 });
  });

  test("a single delivery has nothing behind it", () => {
    const moved = derivedMove([
      task({ updatedAt: "2026-01-01", title: "only", status: "done" }),
    ]);
    expect(moved?.more).toBe(0);
  });

  /** The title travels as DATA, never pre-quoted into a sentence — the row
   *  sets the title and the facts differently. */
  test("the title is returned unwrapped", () => {
    const moved = derivedMove([
      task({ updatedAt: "2026-01-01", title: "Fix og:url", status: "done" }),
    ]);
    expect(moved?.title).toBe("Fix og:url");
  });
});
