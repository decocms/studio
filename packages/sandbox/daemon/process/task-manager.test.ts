import { sleep } from "@decocms/shared/std";
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

describe("TaskManager pipe-mode output decoding", () => {
  it("does not corrupt a multi-byte UTF-8 character split across separate stdout chunks", async () => {
    const tm = makeManager();
    const t = await tm.spawn({
      // Two separate writes with a gap: the ✓ (0xE2 0x9C 0x93) arrives as
      // one stdout 'data' event with a dangling lead byte, then the rest.
      command: "printf '\\xe2\\x9c'; sleep 0.05; printf '\\x93 ok\\n'",
      cwd: "/tmp",
      mode: "pipe",
    });
    await tm.finished(t.id);
    expect(tm.output(t.id)?.stdout).toBe("✓ ok\n");
  });

  it("flushes a dangling multi-byte sequence still buffered when the stream closes", async () => {
    const tm = makeManager();
    const t = await tm.spawn({
      // Writes only the first 2 of 3 bytes of ✓ (0xE2 0x9C 0x93), then exits
      // with no further output — the decoder never sees a completing byte.
      command: "printf '\\xe2\\x9c'",
      cwd: "/tmp",
      mode: "pipe",
    });
    await tm.finished(t.id);
    expect(tm.output(t.id)?.stdout.length).toBeGreaterThan(0);
  });
});

describe("TaskManager kill status", () => {
  it("reports status 'killed' (not 'exited') for a pipe-mode task killed via kill()", async () => {
    const tm = makeManager();
    const t = await tm.spawn({
      command: "sleep 30",
      cwd: "/tmp",
      mode: "pipe",
    });
    const finished = tm.finished(t.id)!;
    tm.kill(t.id, "SIGTERM");
    const result = await finished;
    expect(result.status).toBe("killed");
    expect(tm.get(t.id)?.status).toBe("killed");
  });

  it("flags intentional=true for a single-task kill() (the Stop-by-id route) — a dev-script task stopped this way must not be misread as a crash", async () => {
    const tm = makeManager();
    const t = await tm.spawn({
      command: "sleep 30",
      cwd: "/tmp",
      mode: "pipe",
      logName: "dev",
    });
    const finished = tm.finished(t.id)!;
    tm.kill(t.id, "SIGTERM");
    await finished;
    expect(tm.get(t.id)?.intentional).toBe(true);
  });

  it("flags intentional=true on every task stopped via killAll()", async () => {
    const tm = makeManager();
    const t = await tm.spawn({
      command: "sleep 30",
      cwd: "/tmp",
      mode: "pipe",
    });
    const finished = tm.finished(t.id)!;
    tm.killAll();
    await finished;
    expect(tm.get(t.id)?.intentional).toBe(true);
  });
});

describe("TaskManager killAll", () => {
  it("escalates to SIGKILL when a task ignores SIGTERM", async () => {
    const tm = makeManager();
    const t = await tm.spawn({
      // A busy-loop builtin (no subprocess) that traps and ignores SIGTERM —
      // only SIGKILL can end it, unlike `sleep`, which dies on TERM by default
      // regardless of a shell trap around it.
      command: "trap '' TERM; while true; do :; done",
      cwd: "/tmp",
      mode: "pipe",
    });
    const finished = tm.finished(t.id)!;
    // Give the shell time to install the trap before signaling it — otherwise
    // SIGTERM can race the trap and land while TERM is still fatal.
    await sleep(300);
    const count = tm.killAll();
    expect(count).toBe(1);
    const result = await finished;
    expect(result.status).toBe("killed");
  });
});

describe("TaskManager kill escalation timer", () => {
  it("unrefs the SIGKILL escalation timer so a clean kill doesn't keep the process alive for 3s", async () => {
    const tm = makeManager();
    const t = await tm.spawn({
      command: "sleep 30",
      cwd: "/tmp",
      mode: "pipe",
    });
    const finished = tm.finished(t.id)!;

    const originalSetTimeout = globalThis.setTimeout;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    // @ts-expect-error test-only monkeypatch to capture the escalation timer
    globalThis.setTimeout = (
      fn: TimerHandler,
      ms?: number,
      ...args: unknown[]
    ) => {
      const timer = originalSetTimeout(fn as never, ms, ...args);
      if (ms === 3000) escalationTimer = timer;
      return timer;
    };
    try {
      tm.kill(t.id, "SIGTERM");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    await finished;
    expect(escalationTimer).toBeDefined();
    expect(escalationTimer?.hasRef()).toBe(false);
  });
});

describe("TaskManager summary truncation", () => {
  it("flags summary.truncated when output exceeds the ring buffer but not the tee cap", async () => {
    const tm = makeManager();
    // Ring buffer caps at 256KB per stream; the on-disk tee caps at 10MB.
    // 300KB of output overflows the former but not the latter, so
    // summarize() must reflect the ring buffer's drop, not just the tee's.
    const t = await tm.spawn({
      command: "yes | head -c 300000",
      cwd: "/tmp",
      mode: "pipe",
    });
    await tm.finished(t.id);
    expect(tm.get(t.id)?.truncated).toBe(true);
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
