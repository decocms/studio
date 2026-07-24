import { afterEach, describe, expect, it } from "bun:test";
import {
  applySandboxEvent,
  getLinkState,
  pushSandboxEvent,
  removeSandboxRow,
  resetLinkStateForTests,
  type SandboxRow,
  setActionError,
  setPendingConfirm,
  setPersistedSandboxes,
  setLogPath,
  setSelectedHandle,
} from "./link-store";

type LinkRecord = Parameters<typeof setPersistedSandboxes>[0][number];

function record(handle: string, over: Partial<LinkRecord> = {}): LinkRecord {
  return {
    handle,
    status: "stopped",
    sandboxPath: `/${handle}`,
    port: null,
    previewUrl: null,
    repoCloneUrl: null,
    branch: null,
    projectName: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    lastSeenAt: null,
    missingSince: null,
    ...over,
  };
}

function empty(): Map<string, SandboxRow> {
  return new Map();
}

afterEach(() => resetLinkStateForTests());

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

  it("carries projectName/branch/sandboxPath from a spawning event", () => {
    const m = applySandboxEvent(empty(), {
      handle: "agent-1-feat/x",
      phase: "spawning",
      projectName: "studio",
      branch: "feat/x",
      sandboxPath: "/tmp/deco/sandboxes/agent-1-feat/x",
    });
    expect(m.get("agent-1-feat/x")).toEqual(
      expect.objectContaining({
        status: "spawning",
        projectName: "studio",
        branch: "feat/x",
        sandboxPath: "/tmp/deco/sandboxes/agent-1-feat/x",
      }),
    );
  });

  it("retains metadata across a follow-up event that omits it", () => {
    let m = applySandboxEvent(empty(), {
      handle: "a",
      phase: "spawning",
      projectName: "studio",
      branch: "feat/x",
    });
    m = applySandboxEvent(m, { handle: "a", phase: "ready", port: 7 });
    expect(m.get("a")).toEqual(
      expect.objectContaining({
        status: "ready",
        port: 7,
        projectName: "studio",
        branch: "feat/x",
      }),
    );
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

  it("marks known rows stopped on evicted and deleted", () => {
    let m = applySandboxEvent(empty(), {
      handle: "a",
      phase: "ready",
      port: 7,
      previewUrl: "http://a.localhost:5174",
    });
    m = applySandboxEvent(m, { handle: "a", phase: "evicted" });
    expect(m.get("a")).toEqual(
      expect.objectContaining({
        status: "stopped",
        port: null,
        previewUrl: null,
      }),
    );

    let n = applySandboxEvent(empty(), {
      handle: "b",
      phase: "ready",
      port: 8,
      previewUrl: "http://b.localhost:5174",
    });
    n = applySandboxEvent(n, { handle: "b", phase: "deleted" });
    expect(n.get("b")).toEqual(
      expect.objectContaining({
        status: "stopped",
        port: null,
        previewUrl: null,
      }),
    );
  });

  it("keeps unknown evicted and deleted rows absent", () => {
    let m = applySandboxEvent(empty(), { handle: "a", phase: "evicted" });
    expect(m.has("a")).toBe(false);

    m = applySandboxEvent(m, { handle: "b", phase: "deleted" });
    expect(m.has("b")).toBe(false);
  });
});

describe("setLogPath", () => {
  it("stores the log path on the link state", () => {
    setLogPath("/tmp/deco/link.log");
    expect(getLinkState().logPath).toBe("/tmp/deco/link.log");
  });
});

describe("setPersistedSandboxes", () => {
  it("removes persisted rows that are absent from a fresh registry snapshot", () => {
    setPersistedSandboxes([
      {
        handle: "old",
        status: "stopped",
        sandboxPath: "/tmp/deco/sandboxes/old",
        port: null,
        previewUrl: null,
        repoCloneUrl: null,
        branch: null,
        projectName: null,
        error: null,
        createdAt: 1,
        updatedAt: 2,
        lastSeenAt: 2,
        missingSince: null,
      },
    ]);

    setPersistedSandboxes([]);

    expect(getLinkState().sandboxes.has("old")).toBe(false);
  });

  it("preserves an existing live row over a stale persisted row", () => {
    pushSandboxEvent({
      handle: "old",
      phase: "ready",
      port: 9999,
      previewUrl: "http://old.localhost:5174",
    });

    setPersistedSandboxes([
      {
        handle: "old",
        status: "stopped",
        sandboxPath: "/tmp/deco/sandboxes/old",
        port: null,
        previewUrl: null,
        repoCloneUrl: null,
        branch: "feat/old",
        projectName: "studio",
        error: null,
        createdAt: 1,
        updatedAt: 2,
        lastSeenAt: 2,
        missingSince: null,
      },
    ]);

    expect(getLinkState().sandboxes.get("old")).toEqual(
      expect.objectContaining({
        status: "ready",
        port: 9999,
        previewUrl: "http://old.localhost:5174",
      }),
    );
  });

  it("hydrates stopped and missing rows from the registry", () => {
    setPersistedSandboxes([
      {
        handle: "old",
        status: "stopped",
        sandboxPath: "/tmp/deco/sandboxes/old",
        port: null,
        previewUrl: null,
        repoCloneUrl: "https://github.com/decocms/studio.git",
        branch: "feat/old",
        projectName: "studio",
        error: null,
        createdAt: 1,
        updatedAt: 2,
        lastSeenAt: 2,
        missingSince: null,
      },
      {
        handle: "gone",
        status: "missing",
        sandboxPath: "/tmp/deco/sandboxes/gone",
        port: null,
        previewUrl: null,
        repoCloneUrl: null,
        branch: null,
        projectName: null,
        error: null,
        createdAt: 1,
        updatedAt: 3,
        lastSeenAt: null,
        missingSince: 3,
      },
    ]);

    expect([...getLinkState().sandboxes.values()]).toEqual([
      expect.objectContaining({
        handle: "old",
        status: "stopped",
        branch: "feat/old",
        projectName: "studio",
      }),
      expect.objectContaining({
        handle: "gone",
        status: "missing",
      }),
    ]);
  });

  it("promotes a persisted stopped row when a live ready event arrives", () => {
    setPersistedSandboxes([
      {
        handle: "old",
        status: "stopped",
        sandboxPath: "/tmp/deco/sandboxes/old",
        port: null,
        previewUrl: null,
        repoCloneUrl: null,
        branch: "feat/old",
        projectName: "studio",
        error: null,
        createdAt: 1,
        updatedAt: 2,
        lastSeenAt: 2,
        missingSince: null,
      },
    ]);

    const next = applySandboxEvent(getLinkState().sandboxes, {
      handle: "old",
      phase: "ready",
      port: 9999,
      previewUrl: "http://old.localhost:5174",
    });

    expect(next.get("old")).toEqual(
      expect.objectContaining({
        status: "ready",
        branch: "feat/old",
        port: 9999,
      }),
    );
  });
});

describe("selection setters", () => {
  it("stores the selected handle, confirm, and error", () => {
    setSelectedHandle("h1");
    expect(getLinkState().selectedHandle).toBe("h1");

    setPendingConfirm({
      handle: "h1",
      branch: "b",
      dirtyCount: 0,
      merged: true,
    });
    expect(getLinkState().pendingConfirm?.handle).toBe("h1");

    setActionError("boom");
    expect(getLinkState().actionError).toBe("boom");
  });
});

describe("removeSandboxRow", () => {
  it("drops the row and follows selection to the neighbor", () => {
    setPersistedSandboxes([record("a"), record("b")]);
    setSelectedHandle("a");

    removeSandboxRow("a");

    expect([...getLinkState().sandboxes.keys()]).toEqual(["b"]);
    expect(getLinkState().selectedHandle).toBe("b");
    expect(getLinkState().pendingConfirm).toBeNull();
  });
});
