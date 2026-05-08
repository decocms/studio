import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broadcaster } from "../events/broadcast";
import { gitSync } from "./git-sync";
import { BranchStatusMonitor } from "./branch-status";

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), "branch-status-"));
  gitSync(["init", "-b", "main"], { cwd: repoDir, asUser: false });
  gitSync(["config", "user.email", "test@example.com"], {
    cwd: repoDir,
    asUser: false,
  });
  gitSync(["config", "user.name", "Test"], { cwd: repoDir, asUser: false });
  gitSync(["commit", "--allow-empty", "-m", "init"], {
    cwd: repoDir,
    asUser: false,
  });
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

describe("BranchStatusMonitor", () => {
  let repo: ReturnType<typeof makeRepo>;
  let broadcaster: Broadcaster;
  let events: Array<{ event: string; data: unknown }>;

  beforeEach(() => {
    repo = makeRepo();
    broadcaster = new Broadcaster(1024);
    events = [];
    const orig = broadcaster.broadcastEvent.bind(broadcaster);
    broadcaster.broadcastEvent = (event, data) => {
      events.push({ event, data });
      orig(event, data);
    };
  });

  afterEach(() => repo.cleanup());

  function newMonitor(): BranchStatusMonitor {
    const config = {
      appRoot: repo.repoDir,
      repoDir: repo.repoDir,
      daemonToken: "",
      daemonBootId: "",
      proxyPort: 0,
      dropPrivileges: false,
    } as never;
    return new BranchStatusMonitor(config, broadcaster);
  }

  it("starts in 'initializing' on construction", () => {
    const m = newMonitor();
    expect(m.getLast()).toEqual({ kind: "initializing" });
  });

  it("setPhase('cloning') broadcasts and updates last", () => {
    const m = newMonitor();
    m.setPhase({ kind: "cloning" });
    expect(m.getLast()).toEqual({ kind: "cloning" });
    expect(events).toContainEqual({
      event: "branch-status",
      data: { type: "branch-status", kind: "cloning" },
    });
  });

  it("setPhase('clone-failed') carries the error", () => {
    const m = newMonitor();
    m.setPhase({ kind: "clone-failed", error: "exit 128" });
    expect(m.getLast()).toEqual({ kind: "clone-failed", error: "exit 128" });
    const last = events.at(-1);
    expect(last?.event).toBe("branch-status");
    expect(last?.data).toEqual({
      type: "branch-status",
      kind: "clone-failed",
      error: "exit 128",
    });
  });

  it("markReady() computes git status and emits 'ready'", () => {
    const m = newMonitor();
    m.markReady();
    const last = m.getLast();
    if (last?.kind !== "ready") throw new Error("expected ready");
    expect(last.branch).toBe("main");
    expect(last.workingTreeDirty).toBe(false);
    expect(last.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(events.at(-1)?.event).toBe("branch-status");
  });

  it("markReady() does not re-broadcast identical state", () => {
    const m = newMonitor();
    m.markReady();
    const before = events.length;
    m.markReady();
    expect(events.length).toBe(before);
  });

  it("setPhase deduplicates identical consecutive phases", () => {
    const m = newMonitor();
    m.setPhase({ kind: "cloning" });
    m.setPhase({ kind: "cloning" });
    const cloningEvents = events.filter(
      (e) =>
        e.event === "branch-status" &&
        (e.data as { kind?: string }).kind === "cloning",
    );
    expect(cloningEvents.length).toBe(1);
  });

  it("setPhase overwrites a sticky 'clone-failed'", () => {
    const m = newMonitor();
    m.setPhase({ kind: "clone-failed", error: "x" });
    m.setPhase({ kind: "cloning" });
    expect(m.getLast()).toEqual({ kind: "cloning" });
  });

  // Regression: when appRoot != repoDir AND appRoot is nested inside another
  // git worktree (e.g. host runner: <project>/.deco/sandboxes/<handle>/repo
  // sits under the project's own .git), git's parent-directory walk used to
  // hijack the lookup and report the outer repo's branch. The monitor must
  // resolve git from repoDir and refuse to escape it.
  it("compute() uses repoDir, not appRoot, and does not walk into a parent git repo", () => {
    const outer = mkdtempSync(join(tmpdir(), "branch-status-outer-"));
    try {
      gitSync(["init", "-b", "outer-branch"], { cwd: outer, asUser: false });
      gitSync(["config", "user.email", "outer@example.com"], {
        cwd: outer,
        asUser: false,
      });
      gitSync(["config", "user.name", "Outer"], { cwd: outer, asUser: false });
      gitSync(["commit", "--allow-empty", "-m", "outer"], {
        cwd: outer,
        asUser: false,
      });

      const appRoot = join(outer, "sandbox-app");
      const repoDir = join(appRoot, "repo");
      mkdirSync(repoDir, { recursive: true });
      gitSync(["init", "-b", "inner-branch"], { cwd: repoDir, asUser: false });
      gitSync(["config", "user.email", "inner@example.com"], {
        cwd: repoDir,
        asUser: false,
      });
      gitSync(["config", "user.name", "Inner"], {
        cwd: repoDir,
        asUser: false,
      });
      gitSync(["commit", "--allow-empty", "-m", "inner"], {
        cwd: repoDir,
        asUser: false,
      });

      const config = {
        appRoot,
        repoDir,
        daemonToken: "",
        daemonBootId: "",
        proxyPort: 0,
        dropPrivileges: false,
      } as never;
      const monitor = new BranchStatusMonitor(config, broadcaster);
      monitor.markReady();

      const last = monitor.getLast();
      if (last?.kind !== "ready")
        throw new Error(`expected ready, got ${last?.kind}`);
      expect(last.branch).toBe("inner-branch");
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
