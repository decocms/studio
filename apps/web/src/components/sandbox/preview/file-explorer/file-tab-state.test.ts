import { describe, expect, test } from "bun:test";
import {
  activeFileAfterTabClose,
  fileBufferIsDirty,
  tabIndexForKey,
} from "./file-tab-state";

describe("file tab state", () => {
  test("detects only loaded buffers whose editor value changed", () => {
    expect(fileBufferIsDirty(undefined)).toBeFalse();
    expect(
      fileBufferIsDirty({
        loaded: false,
        savedContent: "saved",
        editorValue: "changed",
      }),
    ).toBeFalse();
    expect(
      fileBufferIsDirty({
        loaded: true,
        savedContent: "same",
        editorValue: "same",
      }),
    ).toBeFalse();
    expect(
      fileBufferIsDirty({
        loaded: true,
        savedContent: "saved",
        editorValue: "changed",
      }),
    ).toBeTrue();
  });

  test("selects the next sibling, then the previous sibling, after close", () => {
    const tabs = ["a.ts", "b.ts", "c.ts"];
    expect(activeFileAfterTabClose(tabs, "b.ts", "b.ts")).toBe("c.ts");
    expect(activeFileAfterTabClose(tabs, "c.ts", "c.ts")).toBe("b.ts");
    expect(activeFileAfterTabClose(tabs, "a.ts", "b.ts")).toBe("a.ts");
    expect(activeFileAfterTabClose(["a.ts"], "a.ts", "a.ts")).toBeNull();
  });

  test("wraps horizontal tab navigation and supports Home and End", () => {
    expect(tabIndexForKey("ArrowLeft", 0, 3)).toBe(2);
    expect(tabIndexForKey("ArrowRight", 2, 3)).toBe(0);
    expect(tabIndexForKey("Home", 2, 3)).toBe(0);
    expect(tabIndexForKey("End", 0, 3)).toBe(2);
    expect(tabIndexForKey("Enter", 1, 3)).toBeNull();
  });
});
