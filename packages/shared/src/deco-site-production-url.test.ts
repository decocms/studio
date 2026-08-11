import { describe, expect, it } from "bun:test";
import {
  pickProductionDomain,
  productionUrlFromDomain,
  resolvePreviewServerUrl,
  sanitizeSiteUrl,
} from "./deco-site-production-url";

describe("pickProductionDomain", () => {
  it("prefers the domain flagged production", () => {
    expect(
      pickProductionDomain([
        { domain: "staging.example.com", production: false },
        { domain: "example.com", production: true },
      ]),
    ).toBe("example.com");
  });

  it("falls back to the first domain when none is flagged production", () => {
    expect(
      pickProductionDomain([
        { domain: "a.example.com", production: false },
        { domain: "b.example.com", production: false },
      ]),
    ).toBe("a.example.com");
  });

  it("returns undefined for empty / nullish", () => {
    expect(pickProductionDomain([])).toBeUndefined();
    expect(pickProductionDomain(null)).toBeUndefined();
    expect(pickProductionDomain(undefined)).toBeUndefined();
  });
});

describe("sanitizeSiteUrl", () => {
  it("returns the canonical href for a valid http(s) URL", () => {
    expect(sanitizeSiteUrl("https://acme.com")).toBe("https://acme.com/");
    expect(sanitizeSiteUrl("http://acme.com/path")).toBe(
      "http://acme.com/path",
    );
  });

  it("trims whitespace", () => {
    expect(sanitizeSiteUrl("  https://acme.com  ")).toBe("https://acme.com/");
  });

  it("rejects non-http(s) schemes", () => {
    expect(sanitizeSiteUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeSiteUrl("ftp://acme.com")).toBeNull();
  });

  it("rejects garbage / empty / nullish", () => {
    expect(sanitizeSiteUrl("not a url")).toBeNull();
    expect(sanitizeSiteUrl("")).toBeNull();
    expect(sanitizeSiteUrl("   ")).toBeNull();
    expect(sanitizeSiteUrl(null)).toBeNull();
    expect(sanitizeSiteUrl(undefined)).toBeNull();
  });
});

describe("productionUrlFromDomain", () => {
  it("prepends https:// to a bare host", () => {
    expect(productionUrlFromDomain("acme.com")).toBe("https://acme.com/");
    expect(productionUrlFromDomain("acme.deco.site")).toBe(
      "https://acme.deco.site/",
    );
  });

  it("preserves an existing scheme", () => {
    expect(productionUrlFromDomain("http://acme.com")).toBe("http://acme.com/");
  });

  it("trims whitespace", () => {
    expect(productionUrlFromDomain("  acme.com ")).toBe("https://acme.com/");
  });

  it("returns null for empty / whitespace / nullish", () => {
    expect(productionUrlFromDomain("")).toBeNull();
    expect(productionUrlFromDomain("   ")).toBeNull();
    expect(productionUrlFromDomain(null)).toBeNull();
    expect(productionUrlFromDomain(undefined)).toBeNull();
  });
});

describe("resolvePreviewServerUrl", () => {
  it("prefers previewServerUrl over the legacy productionUrl key", () => {
    expect(
      resolvePreviewServerUrl({
        previewServerUrl: "https://localhost:3100",
        productionUrl: "https://acme.com",
      }),
    ).toBe("https://localhost:3100/");
  });

  it("falls back to the legacy key when the new one is absent or invalid", () => {
    expect(resolvePreviewServerUrl({ productionUrl: "https://acme.com" })).toBe(
      "https://acme.com/",
    );
    expect(
      resolvePreviewServerUrl({
        previewServerUrl: "not a url",
        productionUrl: "https://acme.com",
      }),
    ).toBe("https://acme.com/");
  });

  it("returns null with neither key or nullish metadata", () => {
    expect(resolvePreviewServerUrl({})).toBeNull();
    expect(resolvePreviewServerUrl(null)).toBeNull();
    expect(resolvePreviewServerUrl(undefined)).toBeNull();
  });
});
