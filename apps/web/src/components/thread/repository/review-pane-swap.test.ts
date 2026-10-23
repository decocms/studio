import { describe, expect, test } from "bun:test";
import { shownReviewPane } from "./review-pane-swap.ts";

const ready = (...ids: string[]) => new Set(ids);

describe("shownReviewPane (v8 publish review)", () => {
  test("a loaded pane shows as soon as its card is picked", () => {
    expect(
      shownReviewPane({
        selectedId: "b",
        readyIds: ready("a", "b"),
        lastShownId: "a",
        liveIds: ["a", "b"],
      }),
    ).toBe("b");
  });

  test("the previous pane stays until the picked one has loaded", () => {
    expect(
      shownReviewPane({
        selectedId: "b",
        readyIds: ready("a"),
        lastShownId: "a",
        liveIds: ["b", "a"],
      }),
    ).toBe("a");
  });

  test("with nothing on screen yet, the picked pane shows (its own spinner)", () => {
    expect(
      shownReviewPane({
        selectedId: "a",
        readyIds: ready(),
        lastShownId: null,
        liveIds: ["a"],
      }),
    ).toBe("a");
  });

  test("a previous pane that is gone (discarded, unmounted) never stays", () => {
    expect(
      shownReviewPane({
        selectedId: "b",
        readyIds: ready("a"),
        lastShownId: "a",
        liveIds: ["b"],
      }),
    ).toBe("b");
  });

  test("no card, no pane", () => {
    expect(
      shownReviewPane({
        selectedId: null,
        readyIds: ready("a"),
        lastShownId: "a",
        liveIds: ["a"],
      }),
    ).toBeNull();
  });
});
