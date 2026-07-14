import { describe, expect, test } from "bun:test";
import { getSourceSystemTabs } from "./source-system-tabs";

describe("getSourceSystemTabs", () => {
  test("returns Blocks, Preview, and Code for clonable source", () => {
    expect(getSourceSystemTabs(true)).toEqual([
      { id: "blocks", title: "Blocks" },
      { id: "preview", title: "Preview" },
      { id: "code", title: "Code" },
    ]);
  });

  test("returns no source tabs without clonable source", () => {
    expect(getSourceSystemTabs(false)).toEqual([]);
  });
});
