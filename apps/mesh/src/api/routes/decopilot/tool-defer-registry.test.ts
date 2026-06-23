import { describe, expect, it } from "bun:test";
import { registerDeferrable, requestDefer } from "./tool-defer-registry";

describe("tool-defer-registry", () => {
  it("resolves the registered promise on requestDefer", async () => {
    const h = registerDeferrable("call-1");
    let fired = false;
    void h.deferred.then(() => {
      fired = true;
    });
    expect(requestDefer("call-1")).toBe(true);
    await h.deferred;
    expect(fired).toBe(true);
    h.dispose();
  });

  it("returns false for unknown tool calls", () => {
    expect(requestDefer("never-registered")).toBe(false);
  });

  it("returns false after dispose (no live registration)", () => {
    const h = registerDeferrable("call-2");
    h.dispose();
    expect(requestDefer("call-2")).toBe(false);
  });
});
