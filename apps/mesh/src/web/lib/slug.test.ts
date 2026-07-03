import { describe, expect, it } from "bun:test";
import { generateSlug } from "./slug";

describe("generateSlug", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(generateSlug("My Cool Site")).toBe("my-cool-site");
  });

  it("strips special characters", () => {
    expect(generateSlug("Acme, Inc.!")).toBe("acme-inc");
  });

  it("collapses runs of whitespace and hyphens into one", () => {
    expect(generateSlug("Foo   --  Bar")).toBe("foo-bar");
  });

  it("trims leading and trailing hyphens", () => {
    expect(generateSlug("  -Foo Bar-  ")).toBe("foo-bar");
  });

  it("preserves existing numbers", () => {
    expect(generateSlug("Site 2026")).toBe("site-2026");
  });

  it("returns an empty string when nothing survives", () => {
    expect(generateSlug("!!!")).toBe("");
  });
});
