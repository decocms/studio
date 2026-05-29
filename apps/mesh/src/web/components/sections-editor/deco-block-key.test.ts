import { describe, expect, it } from "bun:test";
import { assertSafeDecoBlockKey, decoBlockFilePath } from "./deco-block-key";

describe("deco-block-key", () => {
  it("decoBlockFilePath builds the blocks json path", () => {
    expect(decoBlockFilePath("pages-home-abc123456789")).toBe(
      ".deco/blocks/pages-home-abc123456789.json",
    );
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
