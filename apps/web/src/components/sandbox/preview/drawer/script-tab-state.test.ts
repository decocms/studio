import { describe, expect, it } from "bun:test";
import { activeTabAfterScriptClose } from "./script-tab-state";

describe("activeTabAfterScriptClose", () => {
  it("falls back when the closed script is still active", () => {
    expect(activeTabAfterScriptClose("dev", "dev", "setup")).toBe("setup");
  });

  it("preserves a newer selection when an older close request settles", () => {
    expect(activeTabAfterScriptClose("build", "dev", "setup")).toBe("build");
  });
});
