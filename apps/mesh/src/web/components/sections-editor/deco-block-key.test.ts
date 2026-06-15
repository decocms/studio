import { describe, expect, it } from "bun:test";
import {
  assertSafeDecoBlockKey,
  alternateDecoBlockFileStems,
  blockKeyToFileStem,
  decoBlockFilePath,
  legacyDecoBlockFilePaths,
  normalizeDecoBlockKey,
  normalizeDecofileKeys,
} from "./deco-block-key";

describe("deco-block-key", () => {
  it("decoBlockFilePath encodes spaces for the blocks json path", () => {
    expect(decoBlockFilePath("Banner Category")).toBe(
      ".deco/blocks/Banner%20Category.json",
    );
    expect(decoBlockFilePath("pages-home-abc123456789")).toBe(
      ".deco/blocks/pages-home-abc123456789.json",
    );
  });

  it("blockKeyToFileStem does not double-encode an already-encoded key", () => {
    expect(blockKeyToFileStem("Banner%20Category")).toBe("Banner%20Category");
  });

  it("normalizeDecoBlockKey collapses double-encoded page names", () => {
    const uuid = "2292abcd-1234-5678-90ab-cdef12345678";
    expect(normalizeDecoBlockKey(`pages-Home%2520Page-${uuid}`)).toBe(
      `pages-Home Page-${uuid}`,
    );
    expect(normalizeDecoBlockKey(`pages-Home%20Page-${uuid}`)).toBe(
      `pages-Home Page-${uuid}`,
    );
    expect(normalizeDecoBlockKey(`pages-Home Page-${uuid}`)).toBe(
      `pages-Home Page-${uuid}`,
    );
  });

  it("maps legacy and canonical page keys to the same on-disk path", () => {
    const uuid = "2292abcd-1234-5678-90ab-cdef12345678";
    const canonical = `.deco/blocks/pages-Home%20Page-${uuid}.json`;
    expect(decoBlockFilePath(`pages-Home%2520Page-${uuid}`)).toBe(canonical);
    expect(decoBlockFilePath(`pages-Home%20Page-${uuid}`)).toBe(canonical);
    expect(decoBlockFilePath(`pages-Home Page-${uuid}`)).toBe(canonical);
  });

  it("legacyDecoBlockFilePaths removes double-encoded stems after normalization", () => {
    const uuid = "2292abcd-1234-5678-90ab-cdef12345678";
    const normalizedKey = `pages-Home Page-${uuid}`;
    const legacy = legacyDecoBlockFilePaths(normalizedKey);
    expect(legacy).toContain(`.deco/blocks/pages-Home%2520Page-${uuid}.json`);
    expect(legacy).not.toContain(`.deco/blocks/pages-Home%20Page-${uuid}.json`);
  });

  it("alternateDecoBlockFileStems includes canonical and double-encoded variants", () => {
    const uuid = "2292abcd-1234-5678-90ab-cdef12345678";
    const stems = alternateDecoBlockFileStems(`pages-Home Page-${uuid}`);
    expect(stems).toContain(`pages-Home%20Page-${uuid}`);
    expect(stems).toContain(`pages-Home%2520Page-${uuid}`);
  });

  it("normalizeDecofileKeys collapses duplicate encodings", () => {
    const uuid = "2292abcd-1234-5678-90ab-cdef12345678";
    const data = { path: "/" };
    const decofile = normalizeDecofileKeys({
      [`pages-Home%2520Page-${uuid}`]: data,
      [`pages-Home%20Page-${uuid}`]: { path: "/old" },
    });
    expect(Object.keys(decofile)).toEqual([`pages-Home Page-${uuid}`]);
    expect(decofile[`pages-Home Page-${uuid}`]).toEqual({ path: "/old" });
  });

  it("allows spaces and encoded names", () => {
    expect(() => assertSafeDecoBlockKey("Preview Hero")).not.toThrow();
  });

  it("rejects path traversal in block keys", () => {
    expect(() => assertSafeDecoBlockKey("../package.json")).toThrow(
      /Invalid block key/,
    );
    expect(() => assertSafeDecoBlockKey("foo/bar")).toThrow(
      /Invalid block key/,
    );
  });
});
