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

  it("allows percent-encoded slashes (deco slash-named page keys)", () => {
    expect(() => assertSafeDecoBlockKey("foo%2fbar")).not.toThrow();
    expect(() => assertSafeDecoBlockKey("foo%2Fbar")).not.toThrow();
    expect(() =>
      assertSafeDecoBlockKey(
        "pages-Joias%2Fcolecao%2Freligiosos%2Fcruz-862158",
      ),
    ).not.toThrow();
  });

  it("round-trips a slash-named page key through the file stem", () => {
    const key = "pages-Joias%2Fcolecao%2Freligiosos%2Fcruz-862158";
    const stem = "pages-Joias%252Fcolecao%252Freligiosos%252Fcruz-862158";
    expect(blockKeyToFileStem(key)).toBe(stem);
    expect(decoBlockKeyFromFileStem(stem)).toBe(key);
    expect(decoBlockFilePath(key)).toBe(`.deco/blocks/${stem}.json`);
  });
});
