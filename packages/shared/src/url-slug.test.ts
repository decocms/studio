import { describe, expect, it } from "bun:test";
import {
  URL_SLUG_MAX,
  isValidUrlSlug,
  urlSlugBase,
  urlSlugCandidate,
} from "./url-slug";

describe("url slugs", () => {
  it("accepts lowercase words joined by single hyphens", () => {
    expect(isValidUrlSlug("marketing-site")).toBe(true);
    expect(isValidUrlSlug("a1")).toBe(true);
  });

  it("rejects ids, reserved words, and malformed slugs", () => {
    for (const bad of [
      "vir_abc",
      "settings",
      "a",
      "-lead",
      "trail-",
      "x--y",
      "Caps",
      "x".repeat(URL_SLUG_MAX + 1),
    ]) {
      expect(isValidUrlSlug(bad)).toBe(false);
    }
  });

  it("derives a base from a name, or falls back", () => {
    expect(urlSlugBase("Open Rituals!", "app")).toBe("open-rituals");
    expect(urlSlugBase("Café", "app")).toBe("caf");
    expect(urlSlugBase("🚀", "project")).toBe("project");
    expect(urlSlugBase("Settings", "project")).toBe("project");
    expect(urlSlugBase(null, "app")).toBe("app");
    expect(urlSlugBase("a".repeat(100), "app")).toHaveLength(URL_SLUG_MAX);
  });

  it("suffixes candidates within the length limit", () => {
    expect(urlSlugCandidate("rituals", 1)).toBe("rituals");
    expect(urlSlugCandidate("rituals", 3)).toBe("rituals-3");
    const long = "a".repeat(URL_SLUG_MAX);
    const suffixed = urlSlugCandidate(long, 12);
    expect(suffixed).toHaveLength(URL_SLUG_MAX);
    expect(isValidUrlSlug(suffixed)).toBe(true);
  });
});
