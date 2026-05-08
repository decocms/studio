import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TenantConfigStore } from "../config-store";
import { Broadcaster } from "../events/broadcast";
import { TaskManager } from "../process/task-manager";
import { makeExecHandler } from "./exec";

function req(name: string, body?: object): Request {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.body = Buffer.from(JSON.stringify(body), "utf-8").toString("base64");
  }
  return new Request(`http://x/_decopilot_vm/exec/${name}`, init);
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
