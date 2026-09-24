import { describe, expect, it } from "bun:test";
import {
  isValidSiteSlug,
  resolveAgentSiteSlug,
  resolveAnalyticsSiteSlug,
} from "./site-slug";

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

describe("resolveAgentSiteSlug", () => {
  it("prefers the stamped siteSlug so a rename never moves the tenancy", () => {
    expect(
      resolveAgentSiteSlug({
        title: "Acme Store (renamed)",
        metadata: { siteSlug: "acmestore" },
      }),
    ).toBe("acmestore");
  });

  it("falls back to the title for agents imported before siteSlug existed", () => {
    expect(resolveAgentSiteSlug({ title: "acmestore", metadata: {} })).toBe(
      "acmestore",
    );
    expect(resolveAgentSiteSlug({ title: "acmestore" })).toBe("acmestore");
    expect(resolveAgentSiteSlug({ title: "acmestore", metadata: null })).toBe(
      "acmestore",
    );
  });

  it("normalizes case and surrounding whitespace on both keys", () => {
    expect(resolveAgentSiteSlug({ title: "  AcmeStore  " })).toBe("acmestore");
    expect(
      resolveAgentSiteSlug({ title: "x", metadata: { siteSlug: " ACME " } }),
    ).toBe("acme");
  });

  it("treats a blank siteSlug as unset and keeps falling back", () => {
    expect(
      resolveAgentSiteSlug({ title: "acmestore", metadata: { siteSlug: "" } }),
    ).toBe("acmestore");
    expect(
      resolveAgentSiteSlug({
        title: "acmestore",
        metadata: { siteSlug: "   " },
      }),
    ).toBe("acmestore");
    expect(
      resolveAgentSiteSlug({
        title: "acmestore",
        metadata: { siteSlug: null },
      }),
    ).toBe("acmestore");
  });

  it("returns null when there is nothing to resolve", () => {
    expect(resolveAgentSiteSlug(null)).toBeNull();
    expect(resolveAgentSiteSlug(undefined)).toBeNull();
    expect(resolveAgentSiteSlug({})).toBeNull();
    expect(resolveAgentSiteSlug({ title: "   " })).toBeNull();
    expect(
      resolveAgentSiteSlug({ title: null, metadata: { siteSlug: null } }),
    ).toBeNull();
  });
});

describe("resolveAnalyticsSiteSlug", () => {
  it("follows the analytics override for a migrated project", () => {
    expect(
      resolveAnalyticsSiteSlug({
        title: "acme-tanstack",
        metadata: { analyticsSiteSlug: "acme" },
      }),
    ).toBe("acme");
  });

  it("falls back to the project's own site slug without an override", () => {
    expect(
      resolveAnalyticsSiteSlug({
        title: "x",
        metadata: { siteSlug: "acme-tanstack" },
      }),
    ).toBe("acme-tanstack");
  });

  it("normalizes the override", () => {
    expect(
      resolveAnalyticsSiteSlug({ metadata: { analyticsSiteSlug: " ACME " } }),
    ).toBe("acme");
  });

  it("ignores an override that is not a valid slug", () => {
    expect(
      resolveAnalyticsSiteSlug({
        title: "acme-tanstack",
        metadata: { analyticsSiteSlug: "../other" },
      }),
    ).toBe("acme-tanstack");
  });
});
