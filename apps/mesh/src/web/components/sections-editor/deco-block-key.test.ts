import { describe, expect, it } from "bun:test";
import {
  assertSafeDecoBlockKey,
  blockKeyToFileStem,
  decoBlockFilePath,
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
