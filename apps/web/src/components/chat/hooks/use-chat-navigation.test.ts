import { describe, expect, it } from "bun:test";
import { resolveCarriedTab } from "./use-chat-navigation";

describe("resolveCarriedTab", () => {
  it("keeps a per-thread view when no thread is being left", () => {
    expect(resolveCarriedTab("app:conn:tool", null)).toBe("app:conn:tool");
  });

  it("drops a per-thread view when leaving a thread", () => {
    expect(resolveCarriedTab("app:conn:tool", "thread-a")).toBeUndefined();
  });

  it("keeps a system view when leaving a thread", () => {
    expect(resolveCarriedTab("preview", "thread-a")).toBe("preview");
  });

  it("carries nothing without an active view", () => {
    expect(resolveCarriedTab(undefined, null)).toBeUndefined();
  });
});
