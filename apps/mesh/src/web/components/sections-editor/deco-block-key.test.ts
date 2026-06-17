import { describe, expect, it } from "bun:test";
import {
  assertSafeDecoBlockKey,
  blockKeyToFileStem,
  decoBlockFilePath,
  decoBlockKeyFromFileStem,
} from "./deco-block-key";

describe("deco-block-key", () => {
  it("decoBlockFilePath encodes the block id exactly like deco admin", () => {
    expect(decoBlockFilePath("Banner Category")).toBe(
      ".deco/blocks/Banner%20Category.json",
    );
    expect(decoBlockFilePath("pages-home-abc123456789")).toBe(
      ".deco/blocks/pages-home-abc123456789.json",
    );
  });

  it("round-trips legacy page files with double-encoded spaces", () => {
    const uuid = "2292abcd-1234-5678-90ab-cdef12345678";
    const blockKey = `pages-Home%20Page-${uuid}`;
    const stem = `pages-Home%2520Page-${uuid}`;
    expect(blockKeyToFileStem(blockKey)).toBe(stem);
    expect(decoBlockKeyFromFileStem(stem)).toBe(blockKey);
    expect(decoBlockFilePath(blockKey)).toBe(`.deco/blocks/${stem}.json`);
  });

  it("allows spaces and encoded names", () => {
    expect(() => assertSafeDecoBlockKey("Preview Hero")).not.toThrow();
  });

  it("rejects path traversal in block keys", () => {
    expect(() => assertSafeDecoBlockKey("../package.json")).toThrow(
      /Invalid block key/,
    );
  });

  it("allows slashes in block keys", () => {
    expect(() => assertSafeDecoBlockKey("foo/bar")).not.toThrow();
    expect(() =>
      assertSafeDecoBlockKey("MelhoresMalas/MaisVendidos"),
    ).not.toThrow();
  });

  it("rejects percent-encoded slashes in block keys", () => {
    expect(() => assertSafeDecoBlockKey("foo%2fbar")).toThrow(
      /Invalid block key/,
    );
    expect(() => assertSafeDecoBlockKey("foo%2Fbar")).toThrow(
      /Invalid block key/,
    );
  });
});
