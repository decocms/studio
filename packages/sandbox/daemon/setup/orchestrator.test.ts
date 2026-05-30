import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broadcaster } from "../events/broadcast";
import type { BranchStatusMonitor } from "../git/branch-status";
import { LifecycleManager } from "../lifecycle/manager";
import type { LifecycleState } from "../events/types";
import { SetupOrchestrator } from "./orchestrator";

function tempRoot(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "orch-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeMonitorStub(): BranchStatusMonitor {
  return {
    refresh() {},
    getLast: () => ({ kind: "unknown" as const }),
    stop() {},
  } as unknown as BranchStatusMonitor;
}

/** Capture every lifecycle transition the orchestrator emits. */
function makeLifecycleSpy(broadcaster: Broadcaster) {
  const lifecycle = new LifecycleManager({ broadcaster });
  const states: LifecycleState[] = [];
  const orig = lifecycle.transition.bind(lifecycle);
  lifecycle.transition = (next) => {
    states.push(next);
    orig(next);
  };
  return { lifecycle, states };
}

describe("SetupOrchestrator lifecycle integration", () => {
  // Test invokes real `git clone` against an unreachable host; spawnClone
  // retries transient errors a few times before giving up, so the test runs
  // for up to ~15s.
  it("transitions cloning → clone-failed when clone exits non-zero", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const broadcaster = new Broadcaster(1024);
      const { lifecycle, states } = makeLifecycleSpy(broadcaster);

      // cloneUrl points at an unreachable host so spawnClone exits non-zero.
      const orchestrator = new SetupOrchestrator({
        bootConfig: { appRoot: dir, repoDir: join(dir, "repo") },
        store: {
          read: () => ({
            git: {
              repository: { cloneUrl: "https://invalid.example.invalid/x.git" },
            },
            application: {},
          }),
          hydrate: () => {},
          applyInternal: async () => ({
            kind: "applied",
            before: null,
            after: {},
            transition: { kind: "no-op" },
          }),
        } as never,
        taskManager: {
          spawn: async () => ({ id: "t1" }),
          killByLogName: () => 0,
          waitForLogNamesIdle: async () => {},
          onTaskExit: () => () => {},
        } as never,
        setStatus: () => {},
        getStatus: () => ({ state: "running" as const }),
        broadcaster,
        installState: { isInstalledFor: () => false } as never,
        logsDir: dir,
        lifecycle,
        branchStatus: makeMonitorStub(),
      });

      orchestrator.handle({ kind: "bootstrap", config: {} as never });

      const deadline = Date.now() + 15_000;
      while (orchestrator.isRunning() || orchestrator.pendingCount() > 0) {
        if (Date.now() > deadline) throw new Error("orchestrator hung");
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(states[0]).toEqual({ phase: "cloning" });
      expect(states.some((s) => s.phase === "clone-failed")).toBe(true);
    } finally {
      cleanup();
    }
  }, 20_000);

  it("transitions checking-out → clone-failed when checkout fails on existing repo", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repoDir = join(dir, "repo");
      mkdirSync(repoDir);
      // Empty .git so `hasGitRepo` returns true but every `git -C` op fails
      // ("not a git repository"). This forces stepClone into the
      // `else if (cloneUrl)` checkout branch, then makes checkoutBranch's
      // fetch + local-checkout + create-branch all fail → throws → caught by
      // stepClone, which transitions to clone-failed.
      mkdirSync(join(repoDir, ".git"));
      const broadcaster = new Broadcaster(1024);
      const { lifecycle, states } = makeLifecycleSpy(broadcaster);

      const orchestrator = new SetupOrchestrator({
        bootConfig: { appRoot: dir, repoDir },
        store: {
          read: () => ({
            git: {
              repository: {
                cloneUrl: "https://invalid.example.invalid/x.git",
                branch: "feat/x",
              },
            },
            application: {},
          }),
          hydrate: () => {},
          applyInternal: async () => ({
            kind: "applied",
            before: null,
            after: {},
            transition: { kind: "no-op" },
          }),
        } as never,
        taskManager: {
          spawn: async () => ({ id: "t1" }),
          killByLogName: () => 0,
          waitForLogNamesIdle: async () => {},
          onTaskExit: () => () => {},
        } as never,
        setStatus: () => {},
        getStatus: () => ({ state: "running" as const }),
        broadcaster,
        installState: { isInstalledFor: () => false } as never,
        logsDir: dir,
        lifecycle,
        branchStatus: makeMonitorStub(),
      });

      orchestrator.handle({
        kind: "branch-change",
        from: "main",
        to: "feat/x",
      });

      const deadline = Date.now() + 10_000;
      while (orchestrator.isRunning() || orchestrator.pendingCount() > 0) {
        if (Date.now() > deadline) throw new Error("orchestrator hung");
        await new Promise((r) => setTimeout(r, 50));
      }

      const checkingOutIdx = states.findIndex(
        (s) => s.phase === "checking-out",
      );
      const cloneFailedIdx = states.findIndex(
        (s) => s.phase === "clone-failed",
      );
      expect(checkingOutIdx).toBeGreaterThanOrEqual(0);
      expect(cloneFailedIdx).toBeGreaterThan(checkingOutIdx);
    } finally {
      cleanup();
    }
  }, 15_000);
});

describe("SetupOrchestrator status transitions", () => {
  it("flips status to error when a starter task exits non-zero non-intentionally", () => {
    const { dir, cleanup } = tempRoot();
    try {
      let exitHandler: ((s: unknown) => void) | null = null;
      const statusCalls: Array<{ state: string; reason?: string }> = [];
      const broadcaster = new Broadcaster(1024);
      const { lifecycle } = makeLifecycleSpy(broadcaster);

      new SetupOrchestrator({
        bootConfig: { appRoot: dir, repoDir: join(dir, "repo") },
        store: {
          read: () => null,
          hydrate: () => {},
          applyInternal: async () => ({
            kind: "applied",
            before: null,
            after: {},
            transition: { kind: "no-op" },
          }),
        } as never,
        taskManager: {
          spawn: async () => ({ id: "t1" }),
          killByLogName: () => 0,
          waitForLogNamesIdle: async () => {},
          onTaskExit: (h: (s: unknown) => void) => {
            exitHandler = h;
            return () => {};
          },
        } as never,
        setStatus: (i) => statusCalls.push(i),
        getStatus: () => ({ state: "running" as const }),
        broadcaster,
        installState: { isInstalledFor: () => false } as never,
        logsDir: dir,
        lifecycle,
        branchStatus: makeMonitorStub(),
      });

      expect(exitHandler).not.toBeNull();
      exitHandler!({
        id: "t1",
        logName: "dev",
        exitCode: 1,
        intentional: false,
        status: "failed",
      });
      expect(statusCalls).toHaveLength(1);
      expect(statusCalls[0]).toEqual({
        state: "error",
        reason: "dev script exited with code 1",
      });
    } finally {
      cleanup();
    }
  });

  it("does NOT flip status on intentional kill", () => {
    const { dir, cleanup } = tempRoot();
    try {
      let exitHandler: ((s: unknown) => void) | null = null;
      const statusCalls: Array<{ state: string }> = [];
      const broadcaster = new Broadcaster(1024);
      const { lifecycle } = makeLifecycleSpy(broadcaster);

      new SetupOrchestrator({
        bootConfig: { appRoot: dir, repoDir: join(dir, "repo") },
        store: {
          read: () => null,
          hydrate: () => {},
          applyInternal: async () => ({
            kind: "applied",
            before: null,
            after: {},
            transition: { kind: "no-op" },
          }),
        } as never,
        taskManager: {
          spawn: async () => ({ id: "t1" }),
          killByLogName: () => 0,
          waitForLogNamesIdle: async () => {},
          onTaskExit: (h: (s: unknown) => void) => {
            exitHandler = h;
            return () => {};
          },
        } as never,
        setStatus: (i) => statusCalls.push(i),
        getStatus: () => ({ state: "running" as const }),
        broadcaster,
        installState: { isInstalledFor: () => false } as never,
        logsDir: dir,
        lifecycle,
        branchStatus: makeMonitorStub(),
      });

      exitHandler!({
        id: "t1",
        logName: "dev",
        exitCode: 137,
        intentional: true,
        status: "killed",
      });
      expect(statusCalls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("does NOT flip status for non-starter tasks", () => {
    const { dir, cleanup } = tempRoot();
    try {
      let exitHandler: ((s: unknown) => void) | null = null;
      const statusCalls: Array<{ state: string }> = [];
      const broadcaster = new Broadcaster(1024);
      const { lifecycle } = makeLifecycleSpy(broadcaster);

      new SetupOrchestrator({
        bootConfig: { appRoot: dir, repoDir: join(dir, "repo") },
        store: {
          read: () => null,
          hydrate: () => {},
          applyInternal: async () => ({
            kind: "applied",
            before: null,
            after: {},
            transition: { kind: "no-op" },
          }),
        } as never,
        taskManager: {
          spawn: async () => ({ id: "t1" }),
          killByLogName: () => 0,
          waitForLogNamesIdle: async () => {},
          onTaskExit: (h: (s: unknown) => void) => {
            exitHandler = h;
            return () => {};
          },
        } as never,
        setStatus: (i) => statusCalls.push(i),
        getStatus: () => ({ state: "running" as const }),
        broadcaster,
        installState: { isInstalledFor: () => false } as never,
        logsDir: dir,
        lifecycle,
        branchStatus: makeMonitorStub(),
      });

      exitHandler!({
        id: "t2",
        logName: "format",
        exitCode: 1,
        intentional: false,
        status: "failed",
      });
      expect(statusCalls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
