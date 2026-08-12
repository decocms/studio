import { describe, expect, it } from "bun:test";
import { reuseVariantEntryIds } from "./section-variant-list";

describe("reuseVariantEntryIds", () => {
  it("keeps a row's id stable when a variant before it is deleted", () => {
    const current = [
      { id: "e0", index: 0, label: "A" },
      { id: "e1", index: 1, label: "B" },
      { id: "e2", index: 2, label: "C" },
      { id: "e3", index: 3, label: "D" },
    ];
    // "B" (index 1) was deleted — the remaining variants shift up a position.
    const variants = [
      { index: 0, label: "A" },
      { index: 1, label: "C" },
      { index: 2, label: "D" },
    ];

    const next = reuseVariantEntryIds(current, variants);

    expect(next).toEqual([
      { id: "e0", index: 0, label: "A" },
      { id: "e2", index: 1, label: "C" },
      { id: "e3", index: 2, label: "D" },
    ]);
  });

  it("mints a fresh id for a duplicated row and keeps the original's id", () => {
    const current = [
      { id: "e0", index: 0, label: "A" },
      { id: "e1", index: 1, label: "B" },
    ];
    const variants = [
      { index: 0, label: "A" },
      { index: 1, label: "B" },
      { index: 2, label: "B (copy)" },
    ];

    const next = reuseVariantEntryIds(current, variants);

    const copy = next[2];
    expect(next[0]).toEqual({ id: "e0", index: 0, label: "A" });
    expect(next[1]).toEqual({ id: "e1", index: 1, label: "B" });
    expect(copy?.label).toBe("B (copy)");
    expect(copy?.id).not.toBe("e0");
    expect(copy?.id).not.toBe("e1");
  });

  it("keeps two same-label rows' ids stable in order across an unrelated rebuild", () => {
    // Un-renamed duplicates share a label — matching must not collapse them.
    const current = [
      { id: "e0", index: 0, label: "A" },
      { id: "e1", index: 1, label: "A" },
    ];
    const variants = [
      { index: 0, label: "A" },
      { index: 1, label: "A" },
    ];

    const next = reuseVariantEntryIds(current, variants);

    expect(next.map((entry) => entry.id)).toEqual(["e0", "e1"]);
  });
});
