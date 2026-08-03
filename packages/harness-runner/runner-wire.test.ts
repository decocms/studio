/**
 * Black-box test of the runner wire (`main.ts`) — the contract
 * `daemon-go/internal/dispatch/runner.go` depends on. Spawns the real process
 * and talks to it over loopback, so a change to the ready line, the bearer, the
 * NDJSON framing or the terminal `done` fails here instead of in a pod.
 *
 * Deliberately does not exercise a real turn: that needs the `claude` CLI and a
 * live model. The paths asserted here are the ones the daemon reacts to.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const TOKEN = "test-token";
const READY_PREFIX = "HARNESS_RUNNER_READY ";

let proc: ReturnType<typeof Bun.spawn>;
let port: number;

async function readyPort(stdout: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    for (const line of buffered.split("\n")) {
      if (!line.startsWith(READY_PREFIX)) continue;
      reader.releaseLock();
      return JSON.parse(line.slice(READY_PREFIX.length)).port as number;
    }
  }
  reader.releaseLock();
  throw new Error(`runner never reported ready. stdout: ${buffered}`);
}

async function post(
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Parse an NDJSON body into events. */
async function events(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", `${import.meta.dir}/main.ts`], {
    env: {
      ...process.env,
      HARNESS_RUNNER_MODE: "1",
      HARNESS_RUNNER_TOKEN: TOKEN,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  port = await readyPort(proc.stdout as ReadableStream<Uint8Array>);
});

afterAll(() => {
  proc?.kill();
});

describe("harness-runner wire", () => {
  test("reports a usable ephemeral port", () => {
    expect(port).toBeGreaterThan(0);
  });

  test("rejects a missing bearer", async () => {
    const res = await post({ harnessId: "claude-code", input: {} }, {});
    expect(res.status).toBe(401);
  });

  test("rejects a wrong bearer", async () => {
    const res = await post(
      { harnessId: "claude-code", input: {} },
      { authorization: "Bearer nope" },
    );
    expect(res.status).toBe(401);
  });

  test("404s anything that is not POST /run", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(404);
  });

  test("an unknown harness is a 200 error event, terminated by done", async () => {
    const res = await post({ harnessId: "codex", input: {} });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const parsed = await events(res);
    expect(parsed[0]).toMatchObject({
      type: "error",
      code: "unknown_harness",
    });
    expect(parsed.at(-1)).toEqual({ type: "done" });
  });

  test("malformed JSON is bad_input, terminated by done", async () => {
    const res = await post("{not json");
    const parsed = await events(res);
    expect(parsed[0]).toMatchObject({ type: "error", code: "bad_input" });
    expect(parsed.at(-1)).toEqual({ type: "done" });
  });

  test("a missing input is bad_input, terminated by done", async () => {
    const res = await post({ harnessId: "claude-code" });
    const parsed = await events(res);
    expect(parsed[0]).toMatchObject({ type: "error", code: "bad_input" });
    expect(parsed.at(-1)).toEqual({ type: "done" });
  });

  test("exits when stdin closes (daemon death)", async () => {
    const child = Bun.spawn(["bun", `${import.meta.dir}/main.ts`], {
      env: {
        ...process.env,
        HARNESS_RUNNER_MODE: "1",
        HARNESS_RUNNER_TOKEN: TOKEN,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    await readyPort(child.stdout as ReadableStream<Uint8Array>);
    child.stdin.end();
    expect(await child.exited).toBe(0);
  });

  test("refuses to start without the runner env", async () => {
    const child = Bun.spawn(["bun", `${import.meta.dir}/main.ts`], {
      env: {
        ...process.env,
        HARNESS_RUNNER_MODE: "",
        HARNESS_RUNNER_TOKEN: "",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(2);
  });
});
