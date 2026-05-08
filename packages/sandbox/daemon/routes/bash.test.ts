import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager } from "../process/task-manager";
import { makeBashHandler } from "./bash";

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
}

function post(obj: unknown): Request {
  return new Request("http://x/_decopilot_vm/bash", {
    method: "POST",
    body: b64(obj),
  });
}

describe("bash", () => {
  let appRoot = "";
  let logsDir = "";
  let taskManager: TaskManager;
  let h: ReturnType<typeof makeBashHandler>;

  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "bash-handler-"));
    logsDir = mkdtempSync(join(tmpdir(), "bash-logs-"));
    taskManager = new TaskManager({
      logsDir,
      ttlMs: 60_000,
      reapIntervalMs: 60_000,
    });
    h = makeBashHandler({ repoDir: appRoot, taskManager });
  });

  afterEach(() => {
    taskManager.shutdown();
    rmSync(appRoot, { recursive: true, force: true });
    rmSync(logsDir, { recursive: true, force: true });
  });

  it("runs an echo and returns stdout+exitCode=0", async () => {
    const res = await h(post({ command: "echo hello-world" }));
    const body = (await res.json()) as { stdout: string; exitCode: number };
    expect(body.stdout.trim()).toBe("hello-world");
    expect(body.exitCode).toBe(0);
  });

  it("SIGKILLs on timeout and returns exitCode=-1", async () => {
    const res = await h(post({ command: "sleep 30", timeout: 300 }));
    const body = (await res.json()) as { exitCode: number; timedOut: boolean };
    expect(body.timedOut).toBe(true);
    expect(body.exitCode).toBe(-1);
  });

  it("rejects missing command", async () => {
    const res = await h(post({}));
    expect(res.status).toBe(400);
  });

  it("background mode returns taskId immediately", async () => {
    const res = await h(post({ command: "echo bg-mode", mode: "background" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskId: string; status: string };
    expect(typeof body.taskId).toBe("string");
    expect(body.status).toBe("running");
  });

  it("does not leak backgrounded children past the request", async () => {
    const pidFile = join(appRoot, "bg.pid");
    const cmd = `sleep 30 > /dev/null 2>&1 & echo $! > "${pidFile}"; wait $!`;
    const res = await h(post({ command: cmd, timeout: 500 }));
    const body = (await res.json()) as { exitCode: number };
    expect(body.exitCode).toBe(-1);

    expect(existsSync(pidFile)).toBe(true);
    const bgPid = Number(readFileSync(pidFile, "utf-8").trim());
    expect(Number.isInteger(bgPid)).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    let alive = true;
    try {
      process.kill(bgPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});
