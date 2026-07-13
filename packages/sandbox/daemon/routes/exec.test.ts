import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TenantConfigStore } from "../config-store";
import { Broadcaster } from "../events/broadcast";
import type { DaemonStatus, LifecycleState } from "../events/types";
import type { LifecycleManager } from "../lifecycle/manager";
import { TaskManager } from "../process/task-manager";
import { makeExecHandler } from "./exec";

/** Minimal hand-rolled fake — mirrors the real LifecycleManager's surface
 * (`current`/`transition`) without pulling in its Broadcaster dependency. */
function fakeLifecycle(initial: LifecycleState) {
  let state = initial;
  const calls: LifecycleState[] = [];
  const manager = {
    current: () => state,
    transition: (next: LifecycleState) => {
      calls.push(next);
      state = next;
    },
  } as unknown as LifecycleManager;
  return { manager, calls };
}

/** Minimal hand-rolled fake for the daemon's status getter/setter pair. */
function fakeStatus(initial: DaemonStatus) {
  let status = initial;
  const calls: DaemonStatus[] = [];
  return {
    getStatus: () => status,
    setStatus: (next: DaemonStatus) => {
      calls.push(next);
      status = next;
    },
    calls,
  };
}

function req(name: string, body?: object): Request {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(`http://x/_sandbox/exec/${name}`, init);
}

describe("exec handler", () => {
  let appRoot: string;
  let logsDir: string;
  let taskManager: TaskManager;
  let store: TenantConfigStore;
  let broadcaster: Broadcaster;

  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "exec-root-"));
    logsDir = mkdtempSync(join(tmpdir(), "exec-logs-"));
    taskManager = new TaskManager({
      logsDir,
      ttlMs: 60_000,
      reapIntervalMs: 60_000,
    });
    store = new TenantConfigStore();
    broadcaster = new Broadcaster(64 * 1024);
  });

  afterEach(() => {
    taskManager.shutdown();
    rmSync(appRoot, { recursive: true, force: true });
    rmSync(logsDir, { recursive: true, force: true });
  });

  it("rejects 409 when no application is configured", async () => {
    const h = makeExecHandler({
      repoDir: appRoot,
      store,
      taskManager,
      broadcaster,
    });
    const res = await h(req("dev"));
    expect(res.status).toBe(409);
  });

  it("rejects 404 when script is not in package.json", async () => {
    writeFileSync(
      join(appRoot, "package.json"),
      JSON.stringify({ scripts: { test: "echo test" } }),
    );
    await store.apply({
      application: {
        packageManager: { name: "npm" },
        runtime: "node",
      },
    });
    const h = makeExecHandler({
      repoDir: appRoot,
      store,
      taskManager,
      broadcaster,
    });
    const res = await h(req("dev"));
    expect(res.status).toBe(404);
  });

  it("returns taskId for valid script (background mode default)", async () => {
    writeFileSync(
      join(appRoot, "package.json"),
      JSON.stringify({ scripts: { test: "echo hi" } }),
    );
    await store.apply({
      application: {
        packageManager: { name: "npm" },
        runtime: "node",
      },
    });
    const h = makeExecHandler({
      repoDir: appRoot,
      store,
      taskManager,
      broadcaster,
    });
    const res = await h(req("test"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskId: string };
    expect(typeof body.taskId).toBe("string");
  });
});

describe("exec handler — dev-starter lifecycle reconciliation", () => {
  // Regression: a failed dev script wedges status=error / lifecycle=
  // start-failed, and the probe refuses to promote lifecycle out of a
  // terminal phase (anti-resurrection guard). Manually running the dev
  // starter from the studio terminal drawer is explicit user intent and must
  // unwedge both, or the daemon can never report healthy again.
  let appRoot: string;
  let logsDir: string;
  let taskManager: TaskManager;
  let store: TenantConfigStore;

  beforeEach(async () => {
    appRoot = mkdtempSync(join(tmpdir(), "exec-root-"));
    logsDir = mkdtempSync(join(tmpdir(), "exec-logs-"));
    taskManager = new TaskManager({
      logsDir,
      ttlMs: 60_000,
      reapIntervalMs: 60_000,
    });
    store = new TenantConfigStore();
    writeFileSync(
      join(appRoot, "package.json"),
      JSON.stringify({
        scripts: { dev: "echo dev", start: "echo start", build: "echo build" },
      }),
    );
    await store.apply({
      application: {
        packageManager: { name: "npm" },
        runtime: "node",
      },
    });
  });

  afterEach(() => {
    taskManager.shutdown();
    rmSync(appRoot, { recursive: true, force: true });
    rmSync(logsDir, { recursive: true, force: true });
  });

  it("exec of a WELL_KNOWN_STARTERS script clears error status and enters starting from start-failed", async () => {
    const lifecycle = fakeLifecycle({ phase: "start-failed", error: "boom" });
    const status = fakeStatus({ state: "error", reason: "boom" });
    const h = makeExecHandler({
      repoDir: appRoot,
      store,
      taskManager,
      lifecycle: lifecycle.manager,
      getStatus: status.getStatus,
      setStatus: status.setStatus,
    });

    const res = await h(req("dev"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskId: string };
    expect(typeof body.taskId).toBe("string"); // spawn still happens
    expect(status.calls).toEqual([{ state: "running" }]);
    expect(lifecycle.calls).toEqual([{ phase: "starting" }]);
  });

  it("exec of a WELL_KNOWN_STARTERS script leaves a live running lifecycle and non-error status untouched", async () => {
    const lifecycle = fakeLifecycle({
      phase: "running",
      port: 3000,
      htmlSupport: true,
    });
    const status = fakeStatus({ state: "running" });
    const h = makeExecHandler({
      repoDir: appRoot,
      store,
      taskManager,
      lifecycle: lifecycle.manager,
      getStatus: status.getStatus,
      setStatus: status.setStatus,
    });

    const res = await h(req("dev"));

    expect(res.status).toBe(200);
    expect(status.calls).toEqual([]);
    expect(lifecycle.calls).toEqual([]);
  });

  it("exec of a non-starter script never touches status or lifecycle, even from error/start-failed", async () => {
    const lifecycle = fakeLifecycle({ phase: "start-failed", error: "boom" });
    const status = fakeStatus({ state: "error", reason: "boom" });
    const h = makeExecHandler({
      repoDir: appRoot,
      store,
      taskManager,
      lifecycle: lifecycle.manager,
      getStatus: status.getStatus,
      setStatus: status.setStatus,
    });

    const res = await h(req("build"));

    expect(res.status).toBe(200);
    expect(status.calls).toEqual([]);
    expect(lifecycle.calls).toEqual([]);
  });
});
