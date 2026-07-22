import { describe, expect, test } from "bun:test";
import { isSafeLinkUrl, normalizeLinkUrl } from "./rich-text-link-validation";

describe("isSafeLinkUrl", () => {
  test("allows safe protocols", () => {
    expect(isSafeLinkUrl("https://example.com")).toBe(true);
    expect(isSafeLinkUrl("http://example.com")).toBe(true);
    expect(isSafeLinkUrl("mailto:a@example.com")).toBe(true);
    expect(isSafeLinkUrl("tel:+15551234567")).toBe(true);
    expect(isSafeLinkUrl("ftp://example.com/f")).toBe(true);
  });

  test("allows relative, dotted, and fragment links", () => {
    expect(isSafeLinkUrl("/pages/about")).toBe(true);
    expect(isSafeLinkUrl("./sibling")).toBe(true);
    expect(isSafeLinkUrl("#section")).toBe(true);
  });

  test("blocks script-executing protocols, including case and whitespace bypasses", () => {
    expect(isSafeLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeLinkUrl("JavaScript:alert(1)")).toBe(false);
    expect(isSafeLinkUrl(`java${String.fromCharCode(9)}script:alert(1)`)).toBe(
      false,
    );
    expect(isSafeLinkUrl(`java${String.fromCharCode(10)}script:alert(1)`)).toBe(
      false,
    );
    expect(isSafeLinkUrl(" javascript:alert(1)")).toBe(false);
    expect(isSafeLinkUrl("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    );
    expect(isSafeLinkUrl("vbscript:msgbox(1)")).toBe(false);
  });

  test("rejects other unlisted protocols", () => {
    expect(isSafeLinkUrl("ws://example.com")).toBe(false);
    expect(isSafeLinkUrl("chrome-extension://abc/x")).toBe(false);
  });
});

describe("normalizeLinkUrl", () => {
  test("trims whitespace", () => {
    expect(normalizeLinkUrl("  https://example.com  ")).toBe(
      "https://example.com",
    );
  });

  test("defaults a bare domain to https", () => {
    expect(normalizeLinkUrl("example.com")).toBe("https://example.com");
  });

  test("passes through relative, dotted, and fragment links unchanged", () => {
    expect(normalizeLinkUrl("/pages/about")).toBe("/pages/about");
    expect(normalizeLinkUrl("./sibling")).toBe("./sibling");
    expect(normalizeLinkUrl("#section")).toBe("#section");
  });

  test("passes through an already-scoped dangerous URL unchanged, leaving isSafeLinkUrl to reject it", () => {
    expect(normalizeLinkUrl("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(isSafeLinkUrl(normalizeLinkUrl("javascript:alert(1)"))).toBe(false);
  });

  test("returns empty for blank input", () => {
    expect(normalizeLinkUrl("   ")).toBe("");
  });
});
