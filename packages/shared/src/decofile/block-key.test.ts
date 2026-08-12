import { describe, expect, it } from "bun:test";
import {
  assertSafeDecoBlockKey,
  blockKeyToFileStem,
  decoBlockFilePath,
  decoBlockKeyFromFileStem,
  decodeUntilStable,
} from "./block-key";

describe("decodeUntilStable", () => {
  it("returns plain stems unchanged", () => {
    expect(decodeUntilStable("Header")).toBe("Header");
  });

  it("decodes a single-encoded stem", () => {
    expect(decodeUntilStable("Compre%20Junto")).toBe("Compre Junto");
  });

  it("decodes a double-encoded stem to the same key", () => {
    expect(decodeUntilStable("Compre%2520Junto")).toBe("Compre Junto");
  });

  it("leaves a literal + alone (matches decodeURIComponent, not query decoding)", () => {
    expect(decodeUntilStable("a+b")).toBe("a+b");
  });

  it("keeps the last valid form when decoding hits an invalid sequence", () => {
    expect(decodeUntilStable("bad%zz")).toBe("bad%zz");
    // %2525 -> %25 -> % ; a bare "%" fails the next decode and is kept.
    expect(decodeUntilStable("%2525")).toBe("%");
  });
});

describe("blockKeyToFileStem / decoBlockKeyFromFileStem", () => {
  it("round-trips keys with spaces and percent signs", () => {
    for (const key of [
      "Compre Junto",
      "pages-Home%20Page-123",
      "collections/tênis",
      "site",
    ]) {
      expect(decoBlockKeyFromFileStem(blockKeyToFileStem(key))).toBe(key);
    }
  });

  it("escapes slashes so keys never create path segments", () => {
    expect(blockKeyToFileStem("a/b")).toBe("a%2Fb");
    expect(decoBlockFilePath("a/b")).toBe(".deco/blocks/a%2Fb.json");
  });
});

describe("assertSafeDecoBlockKey", () => {
  it("accepts ordinary keys", () => {
    expect(() => assertSafeDecoBlockKey("Compre Junto")).not.toThrow();
    expect(() => assertSafeDecoBlockKey("a/b")).not.toThrow();
  });

  it("rejects traversal and control characters", () => {
    for (const bad of ["", "..", "a\\b", "a\0b", "%2e%2e", "a%2fb"]) {
      expect(() => assertSafeDecoBlockKey(bad)).toThrow();
    }
  });
});
