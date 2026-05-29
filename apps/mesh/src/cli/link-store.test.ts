import { describe, expect, it } from "bun:test";
import { applySandboxEvent, formatIdle, type SandboxRow } from "./link-store";

function empty(): Map<string, SandboxRow> {
  return new Map();
}

describe("applySandboxEvent", () => {
  it("adds a spawning row then promotes it to ready with port", () => {
    let m = applySandboxEvent(
      empty(),
      { handle: "a", phase: "spawning" },
      1000,
    );
    expect(m.get("a")?.status).toBe("spawning");

    m = applySandboxEvent(
      m,
      {
        handle: "a",
        phase: "ready",
        port: 51234,
        previewUrl: "http://a.localhost:5174",
      },
      2000,
    );
    expect(m.get("a")?.status).toBe("ready");
    expect(m.get("a")?.port).toBe(51234);
    expect(m.get("a")?.previewUrl).toBe("http://a.localhost:5174");
  });

  it("records the error on failure and retains the row", () => {
    let m = applySandboxEvent(
      empty(),
      { handle: "a", phase: "spawning" },
      1000,
    );
    m = applySandboxEvent(
      m,
      { handle: "a", phase: "failed", error: "clone failed" },
      2000,
    );
    expect(m.get("a")?.status).toBe("failed");
    expect(m.get("a")?.error).toBe("clone failed");
  });

  it("clears the error when a failed handle starts spawning again", () => {
    let m = applySandboxEvent(
      empty(),
      { handle: "a", phase: "failed", error: "x" },
      1000,
    );
    m = applySandboxEvent(m, { handle: "a", phase: "spawning" }, 2000);
    expect(m.get("a")?.status).toBe("spawning");
    expect(m.get("a")?.error).toBeNull();
  });

  it("preserves the port across a dispatch-count update", () => {
    let m = applySandboxEvent(
      empty(),
      { handle: "a", phase: "ready", port: 7 },
      1000,
    );
    m = applySandboxEvent(
      m,
      { handle: "a", phase: "ready", activeDispatchCount: 2 },
      2000,
    );
    expect(m.get("a")?.port).toBe(7);
    expect(m.get("a")?.activeDispatchCount).toBe(2);
  });

  it("removes the row on evicted and deleted", () => {
    let m = applySandboxEvent(
      empty(),
      { handle: "a", phase: "ready", port: 7 },
      1000,
    );
    m = applySandboxEvent(m, { handle: "a", phase: "evicted" }, 2000);
    expect(m.has("a")).toBe(false);

    let n = applySandboxEvent(
      empty(),
      { handle: "b", phase: "ready", port: 8 },
      1000,
    );
    n = applySandboxEvent(n, { handle: "b", phase: "deleted" }, 2000);
    expect(n.has("b")).toBe(false);
  });
});

describe("formatIdle", () => {
  it("formats sub-minute, minute, and hour ranges", () => {
    expect(formatIdle(500)).toBe("0s");
    expect(formatIdle(5_000)).toBe("5s");
    expect(formatIdle(65_000)).toBe("1m");
    expect(formatIdle(3_700_000)).toBe("1h");
  });
});
