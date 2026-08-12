import { describe, expect, it } from "bun:test";
import { allPrsMerged } from "./archive-merged";

describe("allPrsMerged", () => {
  it("archives only when every linked PR is merged", () => {
    expect(allPrsMerged([true])).toBe(true);
    expect(allPrsMerged([true, true])).toBe(true);
    expect(allPrsMerged([true, false])).toBe(false);
  });

  it("never archives on no PRs or an unreachable GitHub", () => {
    expect(allPrsMerged([])).toBe(false);
    expect(allPrsMerged([null])).toBe(false);
    expect(allPrsMerged([true, null])).toBe(false);
  });
});
