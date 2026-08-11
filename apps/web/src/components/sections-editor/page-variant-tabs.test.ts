import { describe, expect, it } from "bun:test";
import { reuseVariantEntryIds } from "./page-variant-tabs";
import type { PageVariant } from "./page-variants";

function variant(label: string): PageVariant {
  return { label, sections: [] };
}

describe("reuseVariantEntryIds", () => {
  it("keeps a tab's id stable when a variant before it is deleted", () => {
    const current = [
      { id: "e0", index: 0, variant: variant("A") },
      { id: "e1", index: 1, variant: variant("B") },
      { id: "e2", index: 2, variant: variant("C") },
      { id: "e3", index: 3, variant: variant("D") },
    ];
    // "B" (index 1) was deleted — the remaining variants shift up a position.
    const variants = [variant("A"), variant("C"), variant("D")];

    const next = reuseVariantEntryIds(current, variants);

    expect(next.map((entry) => entry.id)).toEqual(["e0", "e2", "e3"]);
    expect(next.map((entry) => entry.index)).toEqual([0, 1, 2]);
  });

  it("mints a fresh id for a duplicated tab and keeps the original's id", () => {
    const current = [
      { id: "e0", index: 0, variant: variant("A") },
      { id: "e1", index: 1, variant: variant("B") },
    ];
    const variants = [variant("A"), variant("B"), variant("B (copy)")];

    const next = reuseVariantEntryIds(current, variants);
    const copy = next[2];

    expect(next[0]?.id).toBe("e0");
    expect(next[1]?.id).toBe("e1");
    expect(copy?.id).not.toBe("e0");
    expect(copy?.id).not.toBe("e1");
  });
});
