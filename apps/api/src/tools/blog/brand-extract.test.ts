import { describe, expect, test } from "bun:test";
import { brandFieldSpecs } from "./brand-extract";

/**
 * The origin label tells the judge which evidence section to check. Pinned
 * because the two drifted once: competitors labelled block-derived while the
 * research had supplied them were scored against site copy that never named a
 * rival, and every one was rejected at confidence 25.
 */
describe("brandFieldSpecs", () => {
  const originOf = (specs: ReturnType<typeof brandFieldSpecs>, field: string) =>
    specs.find((spec) => spec.field === field)?.origin;

  test("points competitors at the research when that is what filled them", () => {
    expect(originOf(brandFieldSpecs("research"), "competitors")).toBe(
      "research",
    );
  });

  test("points competitors at the blocks when the site named them itself", () => {
    expect(originOf(brandFieldSpecs("blocks"), "competitors")).toBe("blocks");
  });

  test("leaves every other field's origin alone", () => {
    const specs = brandFieldSpecs("blocks");
    expect(originOf(specs, "specialDates")).toBe("research");
    expect(originOf(specs, "values")).toBe("blocks");
    expect(originOf(specs, "commercialPolicies")).toBe("blocks");
  });

  test("never judges the brand's own name or language", () => {
    const fields = brandFieldSpecs("research").map((spec) => spec.field);
    expect(fields).not.toContain("companyName");
    expect(fields).not.toContain("language");
  });
});
