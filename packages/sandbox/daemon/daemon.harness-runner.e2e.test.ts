/**
 * Daemon conformance suite — HARNESS-RUNNER SEAM.
 *
 * `/dispatch` runs harnesses in a subprocess (see harness-runner/). A real
 * harness needs the claude/codex CLIs + model providers, so these tests point
 * `HARNESS_RUNNER_CMD` at a fixture runner (written to a temp dir at test
 * time) that speaks the runner wire protocol deterministically. What is
 * asserted here is the daemon's client-facing SSE contract across the
 * subprocess boundary: verbatim chunk relay, error/done framing, runner-crash
 * mapping to `harness_crashed` (with recovery on the next dispatch, no
 * respawn storm), and no orphaned runner after the daemon dies.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_MINIMAL_INPUT } from "../dispatch/fixtures";
import {
  type Daemon,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  readSseUntil,
  startDaemon,
  stopDaemon,
  url,
} from "./daemon.e2e.helpers";

const FIXTURE_RUNNER_SOURCE = `
import { writeFileSync } from "node:fs";
const behavior = process.env.FIXTURE_RUNNER_BEHAVIOR ?? "stream";
const token = process.env.HARNESS_RUNNER_TOKEN ?? "";
const enc = new TextEncoder();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== "Bearer " + token) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const body = await req.json();
    const stream = new ReadableStream({
      start(controller) {
        const write = (e) =>
          controller.enqueue(enc.encode(JSON.stringify(e) + "\\n"));
        write({
          type: "ui-message-chunk",
          chunk: {
            type: "text-delta",
            id: "t1",
            delta: "hello " + body.harnessId + " " + body.input.threadId,
          },
        });
        if (behavior === "crash") {
          setTimeout(() => process.exit(1), 50);
          return;
        }
        if (behavior === "error") {
          write({ type: "error", code: "harness_crashed", message: "boom" });
          write({ type: "done" });
          controller.close();
          return;
        }
        write({
          type: "ui-message-chunk",
          chunk: { type: "text-delta", id: "t1", delta: "world" },
        });
        write({ type: "done" });
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  },
});
if (process.env.FIXTURE_RUNNER_PID_FILE) {
  writeFileSync(process.env.FIXTURE_RUNNER_PID_FILE, String(process.pid));
}
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
console.log("HARNESS_RUNNER_READY " + JSON.stringify({ port: server.port }));
`;

let fixtureDir: string;
let fixtureCmd: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "harness-runner-fixture-"));
  const fixturePath = join(fixtureDir, "fixture-runner.js");
  writeFileSync(fixturePath, FIXTURE_RUNNER_SOURCE);
  fixtureCmd = JSON.stringify(["bun", fixturePath]);
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function dispatchBody(runId: string): string {
  return JSON.stringify({
    runId,
    harnessId: "claude-code",
    input: FIXTURE_MINIMAL_INPUT,
  });
}

async function dispatchUntilDone(
  d: Daemon,
  runId: string,
): Promise<{ res: Response; text: string }> {
  return readSseUntil(url(d, "/_sandbox/dispatch"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: dispatchBody(runId),
    predicate: (acc) => acc.includes('data: {"type":"done"}'),
  });
}

describe("daemon e2e: harness-runner (stream)", () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await startDaemon({
      HARNESS_RUNNER_CMD: fixtureCmd,
      FIXTURE_RUNNER_BEHAVIOR: "stream",
    });
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  it("relays runner chunks verbatim as SSE and terminates with done", async () => {
    const { res, text } = await dispatchUntilDone(d, "run-hr-stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(text.startsWith(": dispatch accepted\n\n")).toBe(true);
    expect(text).toContain(
      'data: {"type":"ui-message-chunk","chunk":{"type":"text-delta","id":"t1","delta":"hello claude-code thr-fixture"}}\n\n',
    );
    expect(text).toContain(
      'data: {"type":"ui-message-chunk","chunk":{"type":"text-delta","id":"t1","delta":"world"}}\n\n',
    );
    expect(text).toContain('data: {"type":"done"}\n\n');
  });

  it("rejects an unknown harness id with 400 unknown_harness (before any runner involvement)", async () => {
    const res = await fetch(url(d, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        runId: "run-hr-unknown",
        harnessId: "nope",
        input: FIXTURE_MINIMAL_INPUT,
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unknown_harness",
    );
  });
});

describe("daemon e2e: harness-runner (harness error)", () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await startDaemon({
      HARNESS_RUNNER_CMD: fixtureCmd,
      FIXTURE_RUNNER_BEHAVIOR: "error",
    });
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  it("propagates a runner error event as harness_crashed with the original message", async () => {
    const { text } = await dispatchUntilDone(d, "run-hr-error");
    expect(text).toContain(
      'data: {"type":"error","code":"harness_crashed","message":"boom"}\n\n',
    );
    expect(text).toContain('data: {"type":"done"}\n\n');
  });
});

describe("daemon e2e: harness-runner (runner crash)", () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await startDaemon({
      HARNESS_RUNNER_CMD: fixtureCmd,
      FIXTURE_RUNNER_BEHAVIOR: "crash",
    });
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  it("maps a mid-stream runner death to SSE harness_crashed + done", async () => {
    const { text } = await dispatchUntilDone(d, "run-hr-crash-1");
    expect(text).toContain('"delta":"hello claude-code thr-fixture"');
    expect(text).toContain('"type":"error","code":"harness_crashed"');
    expect(text).toContain('data: {"type":"done"}\n\n');
  });

  it("recovers on the next dispatch by spawning a fresh runner (no storm, no stuck state)", async () => {
    const { text } = await dispatchUntilDone(d, "run-hr-crash-2");
    expect(text).toContain('"delta":"hello claude-code thr-fixture"');
    expect(text).toContain('"type":"error","code":"harness_crashed"');
    expect(text).toContain('data: {"type":"done"}\n\n');
  });
});

describe("daemon e2e: harness-runner (no orphans)", () => {
  let d: Daemon;
  let pidFile: string;
  beforeAll(async () => {
    pidFile = join(fixtureDir, `runner-${Date.now()}.pid`);
    d = await startDaemon({
      HARNESS_RUNNER_CMD: fixtureCmd,
      FIXTURE_RUNNER_BEHAVIOR: "stream",
      FIXTURE_RUNNER_PID_FILE: pidFile,
    });
  }, HOOK_TIMEOUT_MS);

  it("the runner dies when the daemon is SIGKILLed (stdin-pipe watchdog)", async () => {
    await dispatchUntilDone(d, "run-hr-orphan");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(true);

    await stopDaemon(d);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && isAlive(pid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(isAlive(pid)).toBe(false);
  }, 15_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
