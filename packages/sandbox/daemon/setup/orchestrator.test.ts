import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broadcaster } from "../events/broadcast";
import type { BranchStatusMonitor } from "../git/branch-status";
import { installProtectedBranchHook } from "../git/protect-branch";
import { LifecycleManager } from "../lifecycle/manager";
import type { LifecycleState } from "../events/types";
import { SetupOrchestrator } from "./orchestrator";
import { publishRemoteGolden } from "./remote-golden";

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

describe("SetupOrchestrator idempotent start", () => {
  // A port-change re-enqueues a `start` step. If a dev with the identical
  // command is already running (or still mid-cold-boot), stepStart must skip
  // the kill+respawn — otherwise it SIGTERMs the booting dev and forces a
  // second cold compile (the prod crash-loop this fixes).
  async function drain(o: {
    isRunning: () => boolean;
    pendingCount: () => number;
  }) {
    const deadline = Date.now() + 5_000;
    while (o.isRunning() || o.pendingCount() > 0) {
      if (Date.now() > deadline) throw new Error("orchestrator hung");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("skips respawn when an identical dev is already running", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repoDir = join(dir, "repo");
      mkdirSync(repoDir);
      writeFileSync(
        join(repoDir, "deno.json"),
        JSON.stringify({ tasks: { dev: "echo hi" } }),
      );
      const broadcaster = new Broadcaster(1024);
      const { lifecycle } = makeLifecycleSpy(broadcaster);

      const spawns: Array<{ command: string; cwd: string }> = [];
      // Mutable "what's currently running"; null until we plant the first spawn.
      let running: { command: string; cwd: string } | null = null;

      const orchestrator = new SetupOrchestrator({
        bootConfig: { appRoot: dir, repoDir },
        store: {
          read: () => ({
            application: { packageManager: { name: "deno" }, runtime: "deno" },
            runtimePathDirs: [],
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
          spawn: async (s: { command: string; cwd: string }) => {
            spawns.push({ command: s.command, cwd: s.cwd });
            return { id: `t${spawns.length}` };
          },
          killByLogName: () => 0,
          waitForLogNamesIdle: async () => {},
          runningCommandByLogName: () => running,
          onTaskExit: () => () => {},
        } as never,
        setStatus: () => {},
        getStatus: () => ({ state: "running" as const }),
        broadcaster,
        installState: { isInstalledFor: () => true } as never,
        logsDir: dir,
        lifecycle,
        branchStatus: makeMonitorStub(),
      });

      // 1st start: nothing running → spawns once.
      orchestrator.handle({ kind: "port-change", from: undefined, to: 3000 });
      await drain(orchestrator);
      expect(spawns).toHaveLength(1);

      // Plant the just-spawned dev as "running", then fire another start
      // (a port-change to the sniffed port). Same command → no respawn.
      running = spawns[0];
      orchestrator.handle({ kind: "port-change", from: 3000, to: 8000 });
      await drain(orchestrator);
      expect(spawns).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("respawns when the running command differs", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repoDir = join(dir, "repo");
      mkdirSync(repoDir);
      writeFileSync(
        join(repoDir, "deno.json"),
        JSON.stringify({ tasks: { dev: "echo hi" } }),
      );
      const broadcaster = new Broadcaster(1024);
      const { lifecycle } = makeLifecycleSpy(broadcaster);

      const spawns: Array<{ command: string; cwd: string }> = [];

      const orchestrator = new SetupOrchestrator({
        bootConfig: { appRoot: dir, repoDir },
        store: {
          read: () => ({
            application: { packageManager: { name: "deno" }, runtime: "deno" },
            runtimePathDirs: [],
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
          spawn: async (s: { command: string; cwd: string }) => {
            spawns.push({ command: s.command, cwd: s.cwd });
            return { id: `t${spawns.length}` };
          },
          killByLogName: () => 0,
          waitForLogNamesIdle: async () => {},
          // A stale dev from a different command is running → must be replaced.
          runningCommandByLogName: () => ({
            command: "deno task old",
            cwd: repoDir,
          }),
          onTaskExit: () => () => {},
        } as never,
        setStatus: () => {},
        getStatus: () => ({ state: "running" as const }),
        broadcaster,
        installState: { isInstalledFor: () => true } as never,
        logsDir: dir,
        lifecycle,
        branchStatus: makeMonitorStub(),
      });

      orchestrator.handle({ kind: "port-change", from: undefined, to: 3000 });
      await drain(orchestrator);
      expect(spawns).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
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

describe("SetupOrchestrator lifecycle wedge fixes", () => {
  // Regression: once a dev script exits non-zero, status flips to `error`
  // and lifecycle to `start-failed` (see "flips status to error" above). With
  // nothing to clear `error`, stepStart's status gate silently skips every
  // future `start` step forever — the daemon can never report healthy again.
  // These two entry points are the only ways out: an explicit studio retry
  // (resumeFrom) and the orchestrator itself confirming the exact dev
  // command+cwd is already running (stepStart's already-running branch).

  it("resumeFrom clears an error status before the step enqueues", () => {
    const { dir, cleanup } = tempRoot();
    try {
      const broadcaster = new Broadcaster(1024);
      const { lifecycle } = makeLifecycleSpy(broadcaster);
      let status: { state: string; reason?: string } = {
        state: "error",
        reason: "dev script exited with code 1",
      };
      const statusCalls: Array<{ state: string }> = [];

      const orchestrator = new SetupOrchestrator({
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
          onTaskExit: () => () => {},
        } as never,
        setStatus: (next) => {
          statusCalls.push(next);
          status = next;
        },
        getStatus: () => status,
        broadcaster,
        installState: { isInstalledFor: () => false } as never,
        logsDir: dir,
        lifecycle,
        branchStatus: makeMonitorStub(),
      });

      orchestrator.resumeFrom("start");

      // resumeFrom clears status synchronously, before enqueueStep's
      // fire-and-forget drain ever gets a chance to read it.
      expect(statusCalls).toEqual([{ state: "running" }]);
    } finally {
      cleanup();
    }
  });

  it("resumeFrom leaves a paused status untouched (not a failure)", () => {
    const { dir, cleanup } = tempRoot();
    try {
      const broadcaster = new Broadcaster(1024);
      const { lifecycle } = makeLifecycleSpy(broadcaster);
      const statusCalls: Array<{ state: string }> = [];

      const orchestrator = new SetupOrchestrator({
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
          onTaskExit: () => () => {},
        } as never,
        setStatus: (next) => statusCalls.push(next),
        getStatus: () => ({ state: "paused" as const }),
        broadcaster,
        installState: { isInstalledFor: () => false } as never,
        logsDir: dir,
        lifecycle,
        branchStatus: makeMonitorStub(),
      });

      orchestrator.resumeFrom("start");

      expect(statusCalls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  async function drain(o: {
    isRunning: () => boolean;
    pendingCount: () => number;
  }) {
    const deadline = Date.now() + 5_000;
    while (o.isRunning() || o.pendingCount() > 0) {
      if (Date.now() > deadline) throw new Error("orchestrator hung");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("stepStart's already-running branch reconciles a start-failed lifecycle to starting", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repoDir = join(dir, "repo");
      mkdirSync(repoDir);
      writeFileSync(
        join(repoDir, "deno.json"),
        JSON.stringify({ tasks: { dev: "echo hi" } }),
      );
      const broadcaster = new Broadcaster(1024);
      const { lifecycle, states } = makeLifecycleSpy(broadcaster);

      const spawns: Array<{ command: string; cwd: string }> = [];
      let running: { command: string; cwd: string } | null = null;

      const orchestrator = new SetupOrchestrator({
        bootConfig: { appRoot: dir, repoDir },
        store: {
          read: () => ({
            application: { packageManager: { name: "deno" }, runtime: "deno" },
            runtimePathDirs: [],
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
          spawn: async (s: { command: string; cwd: string }) => {
            spawns.push({ command: s.command, cwd: s.cwd });
            return { id: `t${spawns.length}` };
          },
          killByLogName: () => 0,
          waitForLogNamesIdle: async () => {},
          runningCommandByLogName: () => running,
          onTaskExit: () => () => {},
        } as never,
        setStatus: () => {},
        getStatus: () => ({ state: "running" as const }),
        broadcaster,
        installState: { isInstalledFor: () => true } as never,
        logsDir: dir,
        lifecycle,
        branchStatus: makeMonitorStub(),
      });

      // 1st start: nothing running → spawns once via the normal path
      // (lifecycle → starting there too, but that's not what's under test).
      orchestrator.handle({ kind: "port-change", from: undefined, to: 3000 });
      await drain(orchestrator);
      expect(spawns).toHaveLength(1);

      // Simulate the wedge: the dev script crashed (the real onTaskExit
      // handler would do this), leaving lifecycle at a terminal failure
      // phase the probe refuses to promote from.
      lifecycle.transition({ phase: "start-failed", error: "boom" });

      // But the exact same dev command+cwd is (for whatever reason — a
      // race, a warm-pool reattach) still reported as running by
      // TaskManager. A 2nd start step must reconcile lifecycle instead of
      // silently returning.
      running = spawns[0];
      orchestrator.handle({ kind: "port-change", from: 3000, to: 8000 });
      await drain(orchestrator);

      expect(spawns).toHaveLength(1); // still no respawn
      expect(states.at(-1)).toEqual({ phase: "starting" });
    } finally {
      cleanup();
    }
  });

  it("stepStart's already-running branch is a no-op when lifecycle already reflects running", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repoDir = join(dir, "repo");
      mkdirSync(repoDir);
      writeFileSync(
        join(repoDir, "deno.json"),
        JSON.stringify({ tasks: { dev: "echo hi" } }),
      );
      const broadcaster = new Broadcaster(1024);
      const { lifecycle, states } = makeLifecycleSpy(broadcaster);

      const spawns: Array<{ command: string; cwd: string }> = [];
      let running: { command: string; cwd: string } | null = null;

      const orchestrator = new SetupOrchestrator({
        bootConfig: { appRoot: dir, repoDir },
        store: {
          read: () => ({
            application: { packageManager: { name: "deno" }, runtime: "deno" },
            runtimePathDirs: [],
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
          spawn: async (s: { command: string; cwd: string }) => {
            spawns.push({ command: s.command, cwd: s.cwd });
            return { id: `t${spawns.length}` };
          },
          killByLogName: () => 0,
          waitForLogNamesIdle: async () => {},
          runningCommandByLogName: () => running,
          onTaskExit: () => () => {},
        } as never,
        setStatus: () => {},
        getStatus: () => ({ state: "running" as const }),
        broadcaster,
        installState: { isInstalledFor: () => true } as never,
        logsDir: dir,
        lifecycle,
        branchStatus: makeMonitorStub(),
      });

      // 1st start: nothing running → spawns once.
      orchestrator.handle({ kind: "port-change", from: undefined, to: 3000 });
      await drain(orchestrator);
      expect(spawns).toHaveLength(1);

      // Probe already confirmed the dev server is live.
      lifecycle.transition({
        phase: "running",
        port: 3000,
        htmlSupport: false,
      });
      const statesBefore = states.length;

      running = spawns[0];
      orchestrator.handle({ kind: "port-change", from: 3000, to: 8000 });
      await drain(orchestrator);

      expect(spawns).toHaveLength(1); // still no respawn
      // No new transition beyond the `running` we forced above.
      expect(states.length).toBe(statesBefore);
    } finally {
      cleanup();
    }
  });
});

describe("SetupOrchestrator install-step branch protection", () => {
  // A repo's own postinstall/prepare script (lefthook, husky, ...) can
  // overwrite .git/hooks/pre-push during `bun install`, silently dropping the
  // hook that blocks pushing to main/master from a sandbox. stepInstall must
  // reinstall it after a real install runs.
  it("reinstalls the pre-push hook after an install script clobbers it", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repoDir = join(dir, "repo");
      mkdirSync(repoDir);
      await installProtectedBranchHook(repoDir);
      const hookPath = join(repoDir, ".git", "hooks", "pre-push");

      // A separate script file avoids shell/JSON quoting entirely.
      writeFileSync(
        join(repoDir, "clobber-hook.js"),
        `require("fs").writeFileSync(${JSON.stringify(hookPath)}, "#!/bin/sh\\nexit 0\\n")`,
      );
      writeFileSync(
        join(repoDir, "package.json"),
        JSON.stringify({
          name: "sandbox-fixture",
          scripts: { postinstall: "node clobber-hook.js" },
        }),
      );

      const broadcaster = new Broadcaster(1024);
      const orchestrator = new SetupOrchestrator({
        bootConfig: { appRoot: dir, repoDir },
        store: {
          read: () => ({
            application: { packageManager: { name: "bun" } },
            runtimePathDirs: [],
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
        installState: { isInstalledFor: () => false, mark: () => {} } as never,
        logsDir: dir,
        lifecycle: new LifecycleManager({ broadcaster }),
        branchStatus: makeMonitorStub(),
      });

      orchestrator.handle({
        kind: "pm-change",
        from: undefined,
        to: { name: "bun" },
      });

      const deadline = Date.now() + 15_000;
      while (orchestrator.isRunning() || orchestrator.pendingCount() > 0) {
        if (Date.now() > deadline) throw new Error("orchestrator hung");
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(readFileSync(hookPath, "utf-8")).toContain(
        "not allowed from a sandbox",
      );
    } finally {
      cleanup();
    }
  }, 20_000);
});

describe("SetupOrchestrator dependency-cache reporting", () => {
  async function drain(o: {
    isRunning: () => boolean;
    pendingCount: () => number;
  }) {
    const deadline = Date.now() + 15_000;
    while (o.isRunning() || o.pendingCount() > 0) {
      if (Date.now() > deadline) throw new Error("orchestrator hung");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * The label is the deliverable. `l1` vs `l2` vs `miss` is the only thing
   * that answers "is the shared tier worth its store" — mislabel an L2 hit as
   * `l1` and the dashboard reports a node-local cache doing work it never did,
   * which is worse than no metric at all. Nothing else in the suite pins the
   * label to the branch that actually ran.
   */
  it("reports source=l2 when the shared archive served the install", async () => {
    const { dir, cleanup } = tempRoot();
    const prevRemote = process.env.GOLDEN_CACHE_REMOTE;
    const prevGolden = process.env.GOLDEN_CACHE_ENABLED;
    const logged: string[] = [];
    const realLog = console.log;
    try {
      const repoDir = join(dir, "repo");
      mkdirSync(repoDir);
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({}));
      writeFileSync(join(repoDir, "bun.lock"), '{"lockfileVersion":1}');

      // Publish through the real code, from a DIFFERENT root — this stands in
      // for another node having warmed the shared store.
      const other = join(dir, "other-node");
      mkdirSync(join(other, "node_modules", "left-pad"), { recursive: true });
      writeFileSync(join(other, "bun.lock"), '{"lockfileVersion":1}');
      writeFileSync(
        join(other, "node_modules", "left-pad", "index.js"),
        "module.exports = 1;",
      );
      const remoteRoot = join(dir, "shared");
      mkdirSync(remoteRoot);
      process.env.GOLDEN_CACHE_REMOTE = remoteRoot;
      // L1 stays OFF, so a hit here can only have come from L2.
      delete process.env.GOLDEN_CACHE_ENABLED;
      const cloneUrl = "https://github.com/acme/site.git";
      await publishRemoteGolden({
        config: { git: { repository: { cloneUrl } } } as never,
        installRoot: other,
        pm: "bun",
      });

      const broadcaster = new Broadcaster(1024);
      const { lifecycle } = makeLifecycleSpy(broadcaster);
      const orchestrator = new SetupOrchestrator({
        bootConfig: { appRoot: dir, repoDir },
        store: {
          read: () => ({
            application: { packageManager: { name: "bun" }, runtime: "node" },
            git: { repository: { cloneUrl } },
            runtimePathDirs: [],
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
          runningCommandByLogName: () => null,
          onTaskExit: () => () => {},
        } as never,
        setStatus: () => {},
        getStatus: () => ({ state: "running" as const }),
        broadcaster,
        installState: { isInstalledFor: () => false, mark: () => {} } as never,
        logsDir: dir,
        lifecycle,
        branchStatus: makeMonitorStub(),
      });

      console.log = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      orchestrator.resumeFrom("install");
      await drain(orchestrator);
      console.log = realLog;

      const line = logged.find((l) => l.includes('"sandbox.deps.restore"'));
      expect(line).toBeDefined();
      expect(JSON.parse(line as string).source).toBe("l2");

      // And the install really was skipped in favour of the archive.
      expect(
        readFileSync(
          join(repoDir, "node_modules", "left-pad", "index.js"),
          "utf8",
        ),
      ).toBe("module.exports = 1;");
    } finally {
      console.log = realLog;
      if (prevRemote === undefined) delete process.env.GOLDEN_CACHE_REMOTE;
      else process.env.GOLDEN_CACHE_REMOTE = prevRemote;
      if (prevGolden === undefined) delete process.env.GOLDEN_CACHE_ENABLED;
      else process.env.GOLDEN_CACHE_ENABLED = prevGolden;
      cleanup();
    }
  });
});
