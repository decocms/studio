import { describe, expect, it } from "bun:test";
import {
  assertSafeDecoBlockKey,
  blockKeyToFileStem,
  decoBlockFilePath,
  decoBlockKeyFromFileStem,
} from "./block-key";

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

  it("single-decodes a double-encoded stem to its %20 key (not a space)", () => {
    expect(decoBlockKeyFromFileStem("pages-Home%2520Page-123")).toBe(
      "pages-Home%20Page-123",
    );
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
