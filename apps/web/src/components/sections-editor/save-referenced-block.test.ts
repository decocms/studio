import { describe, expect, it } from "bun:test";
import { assertSafeDecoBlockKey } from "./deco-block-key";
import { createReferencedBlockSaver } from "./save-referenced-block";

describe("save-referenced-block", () => {
  it("guards a nested edit by the exact source its form displayed", () => {
    const opened = { text: "Hello", color: "blue" };
    let current = { Header: opened };
    const saved: unknown[] = [];
    const save = createReferencedBlockSaver(
      (write) => saved.push(write),
      current,
    );
    // Another read replaced the cache; the form still edits its opened copy.
    current = { Header: { text: "Hello", color: "red" } };
    save("Header", { ...opened, text: "Edited" });
    expect(saved).toEqual([
      {
        blockKey: "Header",
        data: { text: "Edited", color: "blue" },
        base: { value: opened, fromCache: true },
        create: false,
      },
    ]);
    expect((saved[0] as { base: { value: unknown } }).base.value).not.toBe(
      current.Header,
    );
    expect(() => save("../Header", {})).toThrow(/Invalid block key/);
    expect(saved).toHaveLength(1);
  });

  it("creates a new referenced block with a must-not-exist guard", () => {
    const saved: unknown[] = [];
    const save = createReferencedBlockSaver((write) => saved.push(write), {});
    save("Header", { text: "Hello" });
    expect(saved).toEqual([
      {
        blockKey: "Header",
        data: { text: "Hello" },
        base: { value: undefined, fromCache: true },
        create: true,
      },
    ]);
  });

  it("rejects encoded path traversal before persistence", () => {
    const saved: unknown[] = [];
    const save = createReferencedBlockSaver((write) => saved.push(write), {});
    expect(() => save("%2e%2e%2fHeader", {})).toThrow(/Invalid block key/);
    expect(saved).toEqual([]);
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
