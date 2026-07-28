import { describe, expect, it } from "bun:test";
import { templateNameForTier } from "./template-name";

const BASE = "studio-sandbox-prod";

describe("templateNameForTier", () => {
  it("uses the base template when no tier is assigned", () => {
    // The chart renders defaultTier at the unsuffixed name, so an unassigned
    // sandbox must keep referencing exactly what it referenced before tiers
    // existed.
    expect(templateNameForTier(BASE, undefined)).toBe(BASE);
    expect(templateNameForTier(BASE, "")).toBe(BASE);
  });

  it("suffixes a well-formed tier", () => {
    expect(templateNameForTier(BASE, "large")).toBe(
      "studio-sandbox-prod-large",
    );
    expect(templateNameForTier(BASE, "gpu-a10")).toBe(
      "studio-sandbox-prod-gpu-a10",
    );
  });

  it("falls back to base and reports a malformed tier", () => {
    const seen: string[] = [];
    for (const bad of [
      "Large",
      "large_pool",
      "-large",
      "large-",
      "9large",
      "a".repeat(17),
      "../other-template",
      "large large",
    ]) {
      expect(templateNameForTier(BASE, bad, (t) => seen.push(t))).toBe(BASE);
    }
    expect(seen).toHaveLength(8);
  });
});
