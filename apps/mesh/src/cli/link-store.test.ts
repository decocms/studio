import { describe, expect, it } from "bun:test";
import {
  applySandboxEvent,
  getLinkState,
  type SandboxRow,
  setLogPath,
} from "./link-store";

function empty(): Map<string, SandboxRow> {
  return new Map();
}

describe("applySandboxEvent", () => {
  it("adds a spawning row then promotes it to ready with port", () => {
    let m = applySandboxEvent(empty(), { handle: "a", phase: "spawning" });
    expect(m.get("a")?.status).toBe("spawning");

    m = applySandboxEvent(m, {
      handle: "a",
      phase: "ready",
      port: 51234,
      previewUrl: "http://a.localhost:5174",
    });
    expect(m.get("a")?.status).toBe("ready");
    expect(m.get("a")?.port).toBe(51234);
    expect(m.get("a")?.previewUrl).toBe("http://a.localhost:5174");
  });

  it("records the error on failure and retains the row", () => {
    let m = applySandboxEvent(empty(), { handle: "a", phase: "spawning" });
    m = applySandboxEvent(m, {
      handle: "a",
      phase: "failed",
      error: "clone failed",
    });
    expect(m.get("a")?.status).toBe("failed");
    expect(m.get("a")?.error).toBe("clone failed");
  });

  it("clears the error when a failed handle starts spawning again", () => {
    let m = applySandboxEvent(empty(), {
      handle: "a",
      phase: "failed",
      error: "x",
    });
    m = applySandboxEvent(m, { handle: "a", phase: "spawning" });
    expect(m.get("a")?.status).toBe("spawning");
    expect(m.get("a")?.error).toBeNull();
  });

  it("preserves the port across a follow-up ready event", () => {
    let m = applySandboxEvent(empty(), {
      handle: "a",
      phase: "ready",
      port: 7,
    });
    m = applySandboxEvent(m, { handle: "a", phase: "ready" });
    expect(m.get("a")?.port).toBe(7);
  });

  it("removes the row on evicted and deleted", () => {
    let m = applySandboxEvent(empty(), {
      handle: "a",
      phase: "ready",
      port: 7,
    });
    m = applySandboxEvent(m, { handle: "a", phase: "evicted" });
    expect(m.has("a")).toBe(false);

    let n = applySandboxEvent(empty(), {
      handle: "b",
      phase: "ready",
      port: 8,
    });
    n = applySandboxEvent(n, { handle: "b", phase: "deleted" });
    expect(n.has("b")).toBe(false);
  });
});

describe("setLogPath", () => {
  it("stores the log path on the link state", () => {
    setLogPath("/tmp/deco/link.log");
    expect(getLinkState().logPath).toBe("/tmp/deco/link.log");
  });
});
