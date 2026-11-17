import { describe, expect, it } from "bun:test";
import { assertSafeDecoBlockKey } from "./deco-block-key";
import { referencedBlockSource } from "./save-referenced-block";

describe("referencedBlockSource", () => {
  it("an edit is made on the exact copy its form displayed", () => {
    const opened = { text: "Hello", color: "blue" };
    const blocks = { Header: opened };
    expect(referencedBlockSource(blocks, "Header", true)).toEqual({
      base: { value: opened, fromCache: true },
      create: false,
    });
    expect(referencedBlockSource(blocks, "Header", true).base.value).toBe(
      opened,
    );
  });

  it("v8 saves a block the listing doesn't hold as a create", () => {
    expect(referencedBlockSource({}, "Header", true)).toEqual({
      base: { value: undefined, fromCache: true },
      create: true,
    });
  });

  it("legacy never sends a create", () => {
    expect(
      referencedBlockSource({ Header: { text: "old" } }, "Header", false),
    ).toEqual({ base: { value: { text: "old" }, fromCache: true } });
    expect(referencedBlockSource({}, "New", false)).toEqual({
      base: { value: undefined, fromCache: true },
    });
  });
});

describe("assertSafeDecoBlockKey encoded traversal", () => {
  it("rejects percent-encoded path traversal (decoded `..`)", () => {
    expect(() => assertSafeDecoBlockKey("%2e%2e")).toThrow(/Invalid block key/);
    expect(() => assertSafeDecoBlockKey("%2e%2e%2fHeader")).toThrow(
      /Invalid block key/,
    );
  });

  it("allows percent-encoded slashes (deco slash-named page keys)", () => {
    expect(() => assertSafeDecoBlockKey("pages-%2fhome")).not.toThrow();
  });
});
