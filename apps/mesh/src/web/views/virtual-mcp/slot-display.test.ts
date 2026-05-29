import { describe, expect, it } from "bun:test";
import { slotDisplayState } from "./slot-display";

describe("slotDisplayState", () => {
  it("uses the resolved connection's title and icon when resolved", () => {
    expect(
      slotDisplayState("deco/mcp-github", {
        title: "GitHub",
        icon: "https://example.com/gh.png",
      }),
    ).toEqual({
      state: "resolved",
      title: "GitHub",
      icon: "https://example.com/gh.png",
    });
  });

  it("falls back to the app_id with no icon when unresolved", () => {
    expect(slotDisplayState("deco/mcp-github", null)).toEqual({
      state: "unresolved",
      title: "deco/mcp-github",
      icon: null,
    });
  });

  it("preserves a null resolved icon", () => {
    expect(
      slotDisplayState("some/app", { title: "Some App", icon: null }),
    ).toEqual({ state: "resolved", title: "Some App", icon: null });
  });
});
