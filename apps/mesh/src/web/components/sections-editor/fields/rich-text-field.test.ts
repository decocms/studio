import { describe, expect, test } from "bun:test";
import { isSafeLinkUrl } from "../rich-text-link-validation";

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
