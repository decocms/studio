import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager } from "./task-manager";

function makeManager() {
  const logsDir = mkdtempSync(join(tmpdir(), "tm-"));
  return new TaskManager({ logsDir });
}

describe("TaskManager intentional flag", () => {
  it("surfaces intentional=true on summary after killByLogName({intentional:true})", async () => {
    const tm = makeManager();
    const t = await tm.spawn({
      command: "sleep 30",
      cwd: "/tmp",
      mode: "pipe",
      logName: "dev",
    });
    const finished = tm.finished(t.id)!;
    const killed = tm.killByLogName("dev", { intentional: true });
    expect(killed).toBe(1);
    await finished;
    const summary = tm.get(t.id)!;
    expect(summary.intentional).toBe(true);
  });

  it("surfaces intentional=false (or undefined) for default kills", async () => {
    const tm = makeManager();
    const t = await tm.spawn({
      command: "sleep 30",
      cwd: "/tmp",
      mode: "pipe",
      logName: "dev",
    });
    const finished = tm.finished(t.id)!;
    tm.killByLogName("dev");
    await finished;
    const summary = tm.get(t.id)!;
    expect(summary.intentional).toBeFalsy();
  });
});

describe("TaskManager replaceByLogName", () => {
  it("kills the running task with the same logName, awaits exit, then spawns", async () => {
    const tm = makeManager();
    const first = await tm.spawn({
      command: "sleep 30",
      cwd: "/tmp",
      mode: "pipe",
      logName: "dev",
    });
    const firstFinished = tm.finished(first.id)!;

    const second = await tm.spawn({
      command: "sleep 30",
      cwd: "/tmp",
      mode: "pipe",
      logName: "dev",
      replaceByLogName: true,
    });

    // First task must be exited (killed) by the time the new spawn returns.
    const firstResult = await firstFinished;
    expect(["killed", "exited", "failed"]).toContain(firstResult.status);
    expect(tm.get(first.id)?.intentional).toBe(true);

    // Second task is fresh and running.
    expect(second.id).not.toBe(first.id);
    expect(tm.get(second.id)?.status).toBe("running");

    // Cleanup.
    tm.killByLogName("dev");
    await tm.finished(second.id);
  });

  it("just spawns when no task with that logName is running", async () => {
    const tm = makeManager();
    const t = await tm.spawn({
      command: "sleep 30",
      cwd: "/tmp",
      mode: "pipe",
      logName: "dev",
      replaceByLogName: true,
    });
    expect(tm.get(t.id)?.status).toBe("running");
    tm.killByLogName("dev");
    await tm.finished(t.id);
  });
});

describe("TaskManager onTaskExit", () => {
  it("fires for every task exit with logName, exitCode, and intentional", async () => {
    const tm = makeManager();
    const events: Array<{
      id: string;
      logName?: string;
      exitCode: number | null;
      intentional?: boolean;
    }> = [];
    tm.onTaskExit((s) => {
      events.push({
        id: s.id,
        logName: s.logName,
        exitCode: s.exitCode,
        intentional: s.intentional,
      });
    });
    const t = await tm.spawn({
      command: "sleep 30",
      cwd: "/tmp",
      mode: "pipe",
      logName: "dev",
    });
    const finished = tm.finished(t.id)!;
    tm.killByLogName("dev", { intentional: true });
    await finished;
    expect(events).toHaveLength(1);
    expect(events[0].logName).toBe("dev");
    expect(events[0].intentional).toBe(true);
  });

  it("returns an unsubscribe function", async () => {
    const tm = makeManager();
    let count = 0;
    const unsub = tm.onTaskExit(() => count++);
    unsub();
    const t = await tm.spawn({
      command: "true",
      cwd: "/tmp",
      mode: "pipe",
    });
    await tm.finished(t.id);
    expect(count).toBe(0);
  });
});

describe("TaskManager waitForLogNamesIdle", () => {
  it("resolves once no task with any of the given logNames is running", async () => {
    const tm = makeManager();
    await tm.spawn({
      command: "sleep 30",
      cwd: "/tmp",
      mode: "pipe",
      logName: "dev",
    });
    await tm.spawn({
      command: "sleep 30",
      cwd: "/tmp",
      mode: "pipe",
      logName: "start",
    });

    const idle = tm.waitForLogNamesIdle(["dev", "start"]);
    tm.killByLogName("dev");
    tm.killByLogName("start");
    await idle;

    const running = tm.list({ status: ["running"] });
    expect(
      running.filter((t) => ["dev", "start"].includes(t.logName ?? "")),
    ).toHaveLength(0);
  });

  it("resolves immediately when no matching task is running", async () => {
    const tm = makeManager();
    await tm.waitForLogNamesIdle(["dev", "start"]);
    expect(true).toBe(true);
  });
});
