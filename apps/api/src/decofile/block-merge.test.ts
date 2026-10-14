import { describe, expect, it } from "bun:test";
import { mergeBlockJson } from "./block-merge";

describe("mergeBlockJson", () => {
  it("keeps the base's edit when the branch left that value alone", () => {
    // The base published a header label; the branch edited a shelf further down.
    const ancestor = { label: "SSRio", shelf: { collection: "680" } };
    const ours = { label: "SSRio", shelf: { collection: "667" } };
    const theirs = { label: "SS Rio", shelf: { collection: "680" } };
    expect(mergeBlockJson(ancestor, ours, theirs)).toEqual({
      label: "SS Rio",
      shelf: { collection: "667" },
    });
  });

  it("lets the branch win only the value both sides changed", () => {
    expect(
      mergeBlockJson(
        { title: "a", subtitle: "a" },
        { title: "branch", subtitle: "a" },
        { title: "base", subtitle: "base" },
      ),
    ).toEqual({ title: "branch", subtitle: "base" });
  });

  it("applies additions and deletions from either side", () => {
    expect(
      mergeBlockJson(
        { keep: 1, droppedByBranch: 1, droppedByBase: 1 },
        { keep: 1, droppedByBase: 1, addedByBranch: 1 },
        { keep: 1, droppedByBranch: 1, addedByBase: 1 },
      ),
    ).toEqual({ keep: 1, addedByBranch: 1, addedByBase: 1 });
  });

  it("merges array items position by position when no position changed on both sides", () => {
    const ancestor = [{ label: "A" }, { label: "B" }, { label: "C" }];
    const ours = [{ label: "A2" }, { label: "B" }, { label: "C" }];
    // The base reordered the last two.
    const theirs = [{ label: "A" }, { label: "C" }, { label: "B" }];
    expect(mergeBlockJson(ancestor, ours, theirs)).toEqual([
      { label: "A2" },
      { label: "C" },
      { label: "B" },
    ]);
  });

  it("keeps the branch's whole array instead of splicing two items together", () => {
    const ancestor = [
      { label: "Gift", href: "/gifts" },
      { label: "Outdoors", href: "/outdoors" },
    ];
    // The branch renamed the first item; the base swapped the two.
    const ours = [
      { label: "Gifts", href: "/gifts" },
      { label: "Outdoors", href: "/outdoors" },
    ];
    const theirs = [
      { label: "Outdoors", href: "/outdoors" },
      { label: "Gift", href: "/gifts" },
    ];
    expect(mergeBlockJson(ancestor, ours, theirs)).toEqual(ours);
  });

  it("keeps the branch's array when a side changed its length", () => {
    expect(mergeBlockJson([1, 2], [1, 2, 3], [0, 2])).toEqual([1, 2, 3]);
  });

  it("treats key order as no change", () => {
    expect(
      mergeBlockJson({ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 1, b: 3 }),
    ).toEqual({ a: 1, b: 3 });
  });

  it("takes the branch's value when the two sides disagree on its type", () => {
    expect(mergeBlockJson({ v: 1 }, { v: [1] }, { v: { n: 1 } })).toEqual({
      v: [1],
    });
  });
});
