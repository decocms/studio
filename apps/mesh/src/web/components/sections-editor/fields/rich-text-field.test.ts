import { describe, expect, test } from "bun:test";
import { isSafeLinkUrl, normalizeLinkUrl } from "../rich-text-link-validation";

describe("isSafeLinkUrl", () => {
  test("allows https URLs", () => {
    expect(isSafeLinkUrl("https://example.com")).toBe(true);
    expect(isSafeLinkUrl("https://example.com/path?q=1#frag")).toBe(true);
  });

  test("allows http URLs", () => {
    expect(isSafeLinkUrl("http://example.com")).toBe(true);
  });

  test("allows mailto links", () => {
    expect(isSafeLinkUrl("mailto:user@example.com")).toBe(true);
  });

  test("allows tel links", () => {
    expect(isSafeLinkUrl("tel:+5511999999999")).toBe(true);
  });

  test("allows ftp links", () => {
    expect(isSafeLinkUrl("ftp://files.example.com")).toBe(true);
  });

  test("allows relative paths", () => {
    expect(isSafeLinkUrl("/about")).toBe(true);
    expect(isSafeLinkUrl("/sale?utm=1")).toBe(true);
  });

  test("allows dot-relative paths", () => {
    expect(isSafeLinkUrl("./page")).toBe(true);
    expect(isSafeLinkUrl("../other")).toBe(true);
  });

  test("allows fragment-only links", () => {
    expect(isSafeLinkUrl("#section")).toBe(true);
  });

  test("rejects javascript: URLs", () => {
    expect(isSafeLinkUrl("javascript:alert('xss')")).toBe(false);
    expect(isSafeLinkUrl("javascript:void(0)")).toBe(false);
  });

  test("rejects data: URLs", () => {
    expect(isSafeLinkUrl("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    );
  });

  test("rejects vbscript: URLs", () => {
    expect(isSafeLinkUrl("vbscript:MsgBox('xss')")).toBe(false);
  });

  test("rejects blob: URLs", () => {
    expect(isSafeLinkUrl("blob:https://example.com/uuid")).toBe(false);
  });

  test("treats protocol-less strings as relative paths (safe)", () => {
    // ":::invalid" is parsed as a relative path against the base URL,
    // resulting in https: protocol — this is safe (not javascript:/data:).
    expect(isSafeLinkUrl(":::invalid")).toBe(true);
  });
});

describe("normalizeLinkUrl", () => {
  test("trims whitespace", () => {
    expect(normalizeLinkUrl("  https://example.com  ")).toBe(
      "https://example.com",
    );
  });

  test("returns empty string for blank input", () => {
    expect(normalizeLinkUrl("")).toBe("");
    expect(normalizeLinkUrl("   ")).toBe("");
  });

  test("prefixes bare domains with https", () => {
    expect(normalizeLinkUrl("example.com")).toBe("https://example.com");
    expect(normalizeLinkUrl("www.example.com/path?q=1")).toBe(
      "https://www.example.com/path?q=1",
    );
  });

  test("keeps URLs that already have a scheme", () => {
    expect(normalizeLinkUrl("http://example.com")).toBe("http://example.com");
    expect(normalizeLinkUrl("mailto:user@example.com")).toBe(
      "mailto:user@example.com",
    );
    expect(normalizeLinkUrl("tel:+5511999999999")).toBe("tel:+5511999999999");
  });

  test("keeps relative and fragment links unchanged", () => {
    expect(normalizeLinkUrl("/about")).toBe("/about");
    expect(normalizeLinkUrl("./page")).toBe("./page");
    expect(normalizeLinkUrl("../other")).toBe("../other");
    expect(normalizeLinkUrl("#section")).toBe("#section");
  });

  test("does not hide unsafe schemes behind https", () => {
    // Normalization must leave the scheme intact so isSafeLinkUrl rejects it.
    expect(normalizeLinkUrl("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(isSafeLinkUrl(normalizeLinkUrl("javascript:alert(1)"))).toBe(false);
  });
});
