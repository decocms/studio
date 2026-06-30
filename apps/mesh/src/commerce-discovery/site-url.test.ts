import { describe, expect, test } from "bun:test";
import { normalizeCommerceSiteUrl } from "./site-url.ts";

describe("normalizeCommerceSiteUrl", () => {
  test("adds https to bare hostnames", () => {
    expect(normalizeCommerceSiteUrl("example.com")).toEqual({
      ok: true,
      value: "https://example.com",
    });
  });

  test("returns origin only for URLs with path query and hash", () => {
    expect(
      normalizeCommerceSiteUrl("https://example.com/path?q=1#section"),
    ).toEqual({
      ok: true,
      value: "https://example.com",
    });
  });

  test("upgrades http URLs to https", () => {
    expect(normalizeCommerceSiteUrl("http://example.com")).toEqual({
      ok: true,
      value: "https://example.com",
    });
  });

  test("preserves explicit ports", () => {
    expect(normalizeCommerceSiteUrl("https://example.com:8443/path")).toEqual({
      ok: true,
      value: "https://example.com:8443",
    });
  });

  test("accepts bare hostnames with ports", () => {
    expect(normalizeCommerceSiteUrl("example.com:8443")).toEqual({
      ok: true,
      value: "https://example.com:8443",
    });
  });

  test("accepts bare hostnames with default https ports and paths", () => {
    expect(normalizeCommerceSiteUrl("store.example.com:443/path")).toEqual({
      ok: true,
      value: "https://store.example.com",
    });
  });

  test("rejects non-http protocols", () => {
    expect(normalizeCommerceSiteUrl("ftp://example.com")).toEqual({
      ok: false,
      error: "Use an HTTP or HTTPS website URL.",
    });
  });

  test("rejects opaque non-http schemes", () => {
    for (const siteUrl of [
      "mailto:owner@example.com",
      "custom:foo@example.com",
    ]) {
      expect(normalizeCommerceSiteUrl(siteUrl)).toEqual({
        ok: false,
        error: "Use an HTTP or HTTPS website URL.",
      });
    }
  });

  test("rejects empty input", () => {
    expect(normalizeCommerceSiteUrl("")).toEqual({
      ok: false,
      error: "Enter a website URL.",
    });
  });

  test("rejects invalid hostnames", () => {
    expect(normalizeCommerceSiteUrl("not a url")).toEqual({
      ok: false,
      error: "Enter a valid website URL.",
    });
  });

  test("rejects hostnames without a dot", () => {
    expect(normalizeCommerceSiteUrl("localhost")).toEqual({
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
      expect(normalizeCommerceSiteUrl(siteUrl)).toEqual({
        ok: false,
        error: "Enter a valid website URL.",
      });
    }
  });
});
