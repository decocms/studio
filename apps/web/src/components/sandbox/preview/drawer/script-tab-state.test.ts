import { describe, expect, it } from "bun:test";
import {
  activeTabAfterScriptClose,
  drawerTabIndexForKey,
} from "./script-tab-state";

describe("activeTabAfterScriptClose", () => {
  it("falls back when the closed script is still active", () => {
    expect(activeTabAfterScriptClose("dev", "dev", "setup")).toBe("setup");
  });

  it("preserves a newer selection when an older close request settles", () => {
    expect(activeTabAfterScriptClose("build", "dev", "setup")).toBe("build");
  });
});

describe("drawerTabIndexForKey", () => {
  it("moves and wraps through a horizontal tab list", () => {
    expect(drawerTabIndexForKey("ArrowRight", 2, 3)).toBe(0);
    expect(drawerTabIndexForKey("ArrowLeft", 0, 3)).toBe(2);
  });

  it("supports Home and End without handling unrelated keys", () => {
    expect(drawerTabIndexForKey("Home", 2, 4)).toBe(0);
    expect(drawerTabIndexForKey("End", 0, 4)).toBe(3);
    expect(drawerTabIndexForKey("Enter", 0, 4)).toBeNull();
  });
});
