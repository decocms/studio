import { describe, expect, test } from "bun:test";
import {
  isConnectionClaimedForSite,
  normalizeReportsSiteUrl,
  siteUrlToHost,
} from "./site-url.ts";

describe("normalizeReportsSiteUrl", () => {
  test("adds https to bare hostnames", () => {
    expect(normalizeReportsSiteUrl("example.com")).toEqual({
      ok: true,
      value: "https://example.com",
    });
  });

  test("returns origin only for URLs with path query and hash", () => {
    expect(
      normalizeReportsSiteUrl("https://example.com/path?q=1#section"),
    ).toEqual({
      ok: true,
      value: "https://example.com",
    });
  });

  test("upgrades http URLs to https", () => {
    expect(normalizeReportsSiteUrl("http://example.com")).toEqual({
      ok: true,
      value: "https://example.com",
    });
  });

  test("preserves explicit ports", () => {
    expect(normalizeReportsSiteUrl("https://example.com:8443/path")).toEqual({
      ok: true,
      value: "https://example.com:8443",
    });
  });

  test("accepts bare hostnames with ports", () => {
    expect(normalizeReportsSiteUrl("example.com:8443")).toEqual({
      ok: true,
      value: "https://example.com:8443",
    });
  });

  test("accepts bare hostnames with default https ports and paths", () => {
    expect(normalizeReportsSiteUrl("store.example.com:443/path")).toEqual({
      ok: true,
      value: "https://store.example.com",
    });
  });

  test("rejects non-http protocols", () => {
    expect(normalizeReportsSiteUrl("ftp://example.com")).toEqual({
      ok: false,
      error: "Use an HTTP or HTTPS website URL.",
    });
  });

  test("rejects opaque non-http schemes", () => {
    for (const siteUrl of [
      "mailto:owner@example.com",
      "custom:foo@example.com",
    ]) {
      expect(normalizeReportsSiteUrl(siteUrl)).toEqual({
        ok: false,
        error: "Use an HTTP or HTTPS website URL.",
      });
    }
  });

  test("rejects empty input", () => {
    expect(normalizeReportsSiteUrl("")).toEqual({
      ok: false,
      error: "Enter a website URL.",
    });
  });

  test("rejects invalid hostnames", () => {
    expect(normalizeReportsSiteUrl("not a url")).toEqual({
      ok: false,
      error: "Enter a valid website URL.",
    });
  });

  test("rejects hostnames without a dot", () => {
    expect(normalizeReportsSiteUrl("localhost")).toEqual({
      ok: false,
      error: "Enter a valid website URL.",
    });
  });

  test("rejects invalid DNS labels", () => {
    for (const siteUrl of [
      "bad_host.com",
      "-example.com",
      ".com",
      "example..com",
    ]) {
      expect(normalizeReportsSiteUrl(siteUrl)).toEqual({
        ok: false,
        error: "Enter a valid website URL.",
      });
    }
  });
});

describe("isConnectionClaimedForSite", () => {
  test("trusts an existing claim when no site is requested (returning session)", () => {
    expect(isConnectionClaimedForSite("", "https://a.com")).toBe(true);
    expect(isConnectionClaimedForSite("   ", undefined)).toBe(true);
  });

  test("matches when the requested site equals the claimed site", () => {
    expect(
      isConnectionClaimedForSite("https://a.com/path", "https://a.com"),
    ).toBe(true);
  });

  test("does not match when the requested site differs from the claimed site", () => {
    expect(isConnectionClaimedForSite("https://b.com", "https://a.com")).toBe(
      false,
    );
  });

  test("does not match when nothing is claimed yet", () => {
    expect(isConnectionClaimedForSite("https://a.com", undefined)).toBe(false);
  });

  test("a malformed non-empty request is NOT treated like an empty one", () => {
    // Regression: both "" and "not-a-url" fail normalizeReportsSiteUrl, but
    // only the empty case should bypass the site-match check — otherwise a
    // garbled ?siteUrl param would silently reuse whatever site the
    // connection happens to already be claimed for.
    expect(isConnectionClaimedForSite("not-a-url", "https://a.com")).toBe(
      false,
    );
  });
});

describe("siteUrlToHost", () => {
  test("returns the bare lowercased host, dropping scheme/path/port", () => {
    expect(siteUrlToHost("https://Shop.Example.com/deck?x=1")).toBe(
      "shop.example.com",
    );
    // The reports service keys diagnostics by bare host — a port would be a
    // key that never matches.
    expect(siteUrlToHost("shop.example.com:8443")).toBe("shop.example.com");
  });

  test("rejects non-http schemes, trailing dots, and dotless hosts", () => {
    expect(siteUrlToHost("ftp://shop.example.com")).toBeNull();
    expect(siteUrlToHost("shop.example.com.")).toBeNull();
    expect(siteUrlToHost("localhost")).toBeNull();
    expect(siteUrlToHost("not a url")).toBeNull();
  });
});
