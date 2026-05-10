import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broadcaster } from "../events/broadcast";
import type { DaemonEventName, DaemonEventPayload } from "../events/types";
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

/** Commit a file at `path` with `content` so it's tracked. */
function commitFile(repoDir: string, path: string, content: string): void {
  writeFileSync(join(repoDir, path), content);
  gitSync(["add", path], { cwd: repoDir, asUser: false });
  gitSync(["commit", "-m", `add ${path}`], { cwd: repoDir, asUser: false });
}

describe("BranchStatusMonitor", () => {
  let repo: ReturnType<typeof makeRepo>;
  let broadcaster: Broadcaster;
  let events: Array<{
    name: DaemonEventName;
    payload: DaemonEventPayload<DaemonEventName>;
  }>;

  beforeEach(() => {
    repo = makeRepo();
    broadcaster = new Broadcaster(1024);
    events = [];
    const orig = broadcaster.emit.bind(broadcaster);
    broadcaster.emit = ((name, payload) => {
      events.push({
        name,
        payload: payload as DaemonEventPayload<DaemonEventName>,
      });
      orig(name, payload);
    }) as Broadcaster["emit"];
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

  it("starts as 'unknown' on construction", () => {
    const m = newMonitor();
    expect(m.getLast()).toEqual({ kind: "unknown" });
  });

  it("refresh() computes git status and emits ready meta", () => {
    const m = newMonitor();
    m.refresh();
    const last = m.getLast();
    if (last?.kind !== "ready") throw new Error("expected ready");
    expect(last.branch).toBe("main");
    expect(last.workingTreeDirty).toBe(false);
    expect(last.headSha).toMatch(/^[0-9a-f]{40}$/);
    const branchEvents = events.filter((e) => e.name === "branch");
    expect(branchEvents.length).toBe(1);
    const first = branchEvents[0];
    if (!first) throw new Error("missing branch event");
    expect((first.payload as DaemonEventPayload<"branch">).meta.kind).toBe(
      "ready",
    );
  });

  it("refresh() does not re-emit identical state", () => {
    const m = newMonitor();
    m.refresh();
    const before = events.length;
    m.refresh();
    expect(events.length).toBe(before);
  });

  describe("dirty baseline", () => {
    it("ignores baseline-dirty paths when computing workingTreeDirty", () => {
      // Simulate: dev script regenerates a tracked file (e.g. tailwind.css).
      commitFile(repo.repoDir, "tailwind.css", "/* original */");
      writeFileSync(join(repo.repoDir, "tailwind.css"), "/* regenerated */");

      const m = newMonitor();
      m.armBaseline();
      const last = m.getLast();
      if (last?.kind !== "ready") throw new Error("expected ready");
      expect(last.workingTreeDirty).toBe(false);
    });

    it("flips dirty=true when a non-baseline file changes", () => {
      commitFile(repo.repoDir, "tailwind.css", "/* original */");
      commitFile(repo.repoDir, "src.ts", "export const x = 1;");
      writeFileSync(join(repo.repoDir, "tailwind.css"), "/* regenerated */");

      const m = newMonitor();
      m.armBaseline();
      expect(
        (m.getLast() as { workingTreeDirty: boolean }).workingTreeDirty,
      ).toBe(false);

      // User now edits a different file — must surface as dirty.
      writeFileSync(join(repo.repoDir, "src.ts"), "export const x = 2;");
      m.refresh();
      expect(
        (m.getLast() as { workingTreeDirty: boolean }).workingTreeDirty,
      ).toBe(true);
    });

    it("clearBaseline() restores raw dirty reporting", () => {
      commitFile(repo.repoDir, "tailwind.css", "/* original */");
      writeFileSync(join(repo.repoDir, "tailwind.css"), "/* regenerated */");

      const m = newMonitor();
      m.armBaseline();
      expect(
        (m.getLast() as { workingTreeDirty: boolean }).workingTreeDirty,
      ).toBe(false);

      m.clearBaseline();
      expect(
        (m.getLast() as { workingTreeDirty: boolean }).workingTreeDirty,
      ).toBe(true);
    });
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
      monitor.refresh();

      const last = monitor.getLast();
      if (last?.kind !== "ready")
        throw new Error(`expected ready, got ${last?.kind}`);
      expect(last.branch).toBe("inner-branch");
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
