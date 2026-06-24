import { describe, expect, it } from "bun:test";
import { isValidSiteSlug } from "./site-slug";

describe("isValidSiteSlug", () => {
  it("accepts valid lowercase slugs", () => {
    for (const slug of [
      "acme",
      "my-site-123",
      "1password",
      "a",
      "a".repeat(60), // 1 + 59 = max length
    ]) {
      expect(isValidSiteSlug(slug)).toBe(true);
    }
  });

  it("rejects slugs that could broaden the IAM policy or exceed limits", () => {
    for (const slug of [
      "", // empty
      "ACME", // uppercase
      "Acme",
      "-bad", // leading hyphen
      "a/b", // slash — would broaden the resource ARN
      "a*", // wildcard — would broaden the resource ARN
      "a b", // space
      "site_name", // underscore not allowed
      "a".repeat(61), // too long
    ]) {
      expect(isValidSiteSlug(slug)).toBe(false);
    }
  });
});
