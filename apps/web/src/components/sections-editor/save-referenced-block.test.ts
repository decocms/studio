import { describe, expect, it } from "bun:test";
import { assertSafeDecoBlockKey } from "./deco-block-key";
import { createReferencedBlockSaver } from "./save-referenced-block";

describe("save-referenced-block", () => {
  it("validates block keys before saving", () => {
    const saved: Array<{ key: string; data: Record<string, unknown> }> = [];
    const save = createReferencedBlockSaver((blockKey, data) => {
      saved.push({ key: blockKey, data });
    });

    save("Header", { text: "Hello" });
    expect(saved).toEqual([{ key: "Header", data: { text: "Hello" } }]);

    expect(() => save("../Header", {})).toThrow(/Invalid block key/);
    expect(saved).toHaveLength(1);
  });

  it("rejects encoded path traversal in block keys", () => {
    const save = createReferencedBlockSaver(() => {});
    expect(() => save("%2e%2e%2fHeader", {})).toThrow(/Invalid block key/);
  });
});

describe("assertSafeDecoBlockKey encoded traversal", () => {
  it("rejects percent-encoded path segments", () => {
    expect(() => assertSafeDecoBlockKey("%2e%2e")).toThrow(/Invalid block key/);
    expect(() => assertSafeDecoBlockKey("pages-%2fhome")).toThrow(
      /Invalid block key/,
    );
  });
});
