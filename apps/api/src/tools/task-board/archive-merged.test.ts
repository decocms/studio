import { describe, expect, it } from "bun:test";
import { allPrsMerged, groupByOrg } from "./archive-merged";

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

describe("groupByOrg", () => {
  it("gives each org one leg, keeping its candidates together", () => {
    expect(
      groupByOrg([
        { id: "a", organizationId: "org-1" },
        { id: "b", organizationId: "org-2" },
        { id: "c", organizationId: "org-1" },
      ]),
    ).toEqual([
      { organizationId: "org-1", itemIds: ["a", "c"] },
      { organizationId: "org-2", itemIds: ["b"] },
    ]);
  });

  it("has no legs for an empty work list", () => {
    expect(groupByOrg([])).toEqual([]);
  });
});
