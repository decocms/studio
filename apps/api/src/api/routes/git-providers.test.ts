import { describe, expect, test } from "bun:test";
import { sanitizeReturnTo } from "./git-providers";

describe("sanitizeReturnTo", () => {
  test("keeps a same-origin path", () => {
    expect(sanitizeReturnTo("/acme/settings/repositories")).toBe(
      "/acme/settings/repositories",
    );
    expect(sanitizeReturnTo("/acme?tab=git#top")).toBe("/acme?tab=git#top");
  });

  test("falls back to the root when absent", () => {
    expect(sanitizeReturnTo(undefined)).toBe("/");
    expect(sanitizeReturnTo(null)).toBe("/");
    expect(sanitizeReturnTo("")).toBe("/");
  });

  /**
   * The provider redirect echoes this value back, so anything that could
   * resolve to another origin is an open redirect and must be refused.
   */
  test("refuses anything that can leave the origin", () => {
    expect(sanitizeReturnTo("https://evil.example/steal")).toBe("/");
    expect(sanitizeReturnTo("//evil.example/steal")).toBe("/");
    expect(sanitizeReturnTo("/\\evil.example")).toBe("/");
    expect(sanitizeReturnTo("\\\\evil.example")).toBe("/");
    expect(sanitizeReturnTo("javascript:alert(1)")).toBe("/");
    expect(sanitizeReturnTo("acme/settings")).toBe("/");
  });
});
