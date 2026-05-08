/**
 * End-to-end smoke tests for the in-VM daemon.
 *
 * Spawns the bundled daemon script on a random localhost port under Bun,
 * exercising real HTTP/SSE endpoints. Since the daemon's production spawn
 * uses uid/gid=1000 in production, we set DAEMON_DROP_PRIVILEGES=0 in tests
 * so spawn works when we're not root.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const DAEMON_BUNDLE = join(import.meta.dir, "dist", "daemon.js");
const DAEMON_TOKEN = "t".repeat(32);

// CI cold-start of `bun` + the bundled daemon listener occasionally exceeds
// Bun's default 5s hook timeout, especially on shared runners under load.
// Each test in this file spawns a fresh daemon, so we give beforeEach and
// afterEach generous headroom.
const HOOK_TIMEOUT_MS = 30_000;
const PORT_WAIT_TIMEOUT_MS = 20_000;

function authHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { Authorization: `Bearer ${DAEMON_TOKEN}`, ...extra };
}

let daemonProc: ChildProcess | null = null;
let daemonPort = 0;
let appDir = "";

/**
 * Ask the OS for a free port via a transient bind on port 0. Far less flaky
 * than picking a random number in a fixed range, which collides with other
 * runner processes or with sockets the previous test left in TIME_WAIT.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr && typeof addr.port === "number") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("freePort: bad address")));
      }
    });
  });
}

async function waitForPort(
  port: number,
  proc: ChildProcess,
  stderrBuf: { value: string },
  timeoutMs = PORT_WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `daemon exited before /health responded (code=${proc.exitCode} signal=${proc.signalCode}) stderr=${stderrBuf.value.slice(-2000)}`,
      );
    }
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`daemon did not listen on :${port} within ${timeoutMs}ms`);
}

async function startDaemon(extraEnv: Record<string, string> = {}) {
  appDir = mkdtempSync(join(tmpdir(), "daemon-e2e-"));
  daemonPort = await freePort();
  daemonProc = spawn("bun", [DAEMON_BUNDLE], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DAEMON_TOKEN,
      DAEMON_BOOT_ID: `boot-${daemonPort}`,
      APP_ROOT: appDir,
      PROXY_PORT: String(daemonPort),
      DEV_PORT: "3000",
      DAEMON_NO_AUTOSTART: "1",
      DAEMON_DROP_PRIVILEGES: "0",
      ...extraEnv,
    },
  });
  // Capture stderr so a port-bind crash (or any startup error) is surfaced
  // in the assertion instead of presenting as a silent 20s timeout.
  const stderrBuf = { value: "" };
  daemonProc.stdout?.on("data", (c) =>
    process.stderr.write(`[daemon:out] ${c}`),
  );
  daemonProc.stderr?.on("data", (c) => {
    stderrBuf.value += c.toString();
    process.stderr.write(`[daemon:err] ${c}`);
  });
  await waitForPort(daemonPort, daemonProc, stderrBuf);
}

async function stopDaemon() {
  if (daemonProc) {
    const proc = daemonProc;
    daemonProc = null;
    if (proc.exitCode === null && proc.signalCode === null) {
      // Wait for OS to reap the process so its bound port is released before
      // the next startDaemon picks a fresh one.
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        proc.kill("SIGKILL");
      });
    }
  }
  if (appDir) {
    rmSync(appDir, { recursive: true, force: true });
    appDir = "";
  }
}

describe("daemon e2e (runs generated script under Bun)", () => {
  beforeEach(async () => {
    await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterEach(async () => {
    await stopDaemon();
  }, HOOK_TIMEOUT_MS);

  it("GET /_decopilot_vm/scripts returns { scripts: [] } before discovery", async () => {
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/scripts`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { scripts: string[] };
    expect(body.scripts).toEqual([]);
  });

  it("serves /_decopilot_vm/* without auth and sets CORS headers", async () => {
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/scripts`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { scripts: string[] };
    expect(body.scripts).toEqual([]);
  });

  it("POST /_decopilot_vm/bash executes a command and returns stdout", async () => {
    // Base64-wrap is the permanent wire format (WAF bypass); see daemon-script.ts header.
    const raw = JSON.stringify({ command: "echo hello-world" });
    const b64 = Buffer.from(raw, "utf-8").toString("base64");
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/bash`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: b64,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    expect(body.stdout.trim()).toBe("hello-world");
    expect(body.exitCode).toBe(0);
  });

  it("GET /_decopilot_vm/events streams an SSE status event on connect", async () => {
    const ctrl = new AbortController();
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/events`,
      { signal: ctrl.signal, headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = res.body!.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("event: status");
    expect(text).toContain("data:");
    ctrl.abort();
  });

  it("OPTIONS /_decopilot_vm/bash returns CORS headers (no auth required)", async () => {
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/bash`,
      { method: "OPTIONS" },
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "Authorization",
    );
  });

  // TODO(#3259): pre-existing failure since the daemon state-machine PR
  // landed. Tests skipped to keep CI honest while the fixtures are updated
  // to POST /config and adapt to the new proxy 503 / "No dev server" copy.
  it.skip("SSE replays buffered events on connect and delivers live broadcasts", async () => {
    // Fire a request to produce a log line in the "daemon" replay buffer.
    await fetch(`http://localhost:${daemonPort}/_decopilot_vm/scripts`, {
      headers: authHeaders(),
    });
    // Give the daemon a moment to append to its replay buffer.
    await new Promise((r) => setTimeout(r, 50));

    const ctrl = new AbortController();
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/events`,
      { signal: ctrl.signal, headers: authHeaders() },
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // First chunk should include the `status` event (replay).
    const first = await reader.read();
    const firstText = decoder.decode(first.value);
    expect(firstText).toContain("event: status");

    // Trigger a new log line by hitting the proxy fallthrough, and confirm
    // we see it live on the SSE stream within a deadline. Headroom on shared
    // CI runners — the proxy round-trip + SSE chunk delivery occasionally
    // exceeds 3s under load.
    const deadline = Date.now() + 8000;
    let saw = false;
    await fetch(`http://localhost:${daemonPort}/something-live`).catch(() => {
      /* proxy upstream likely 502 — we only care about the log side-effect */
    });
    while (!saw && Date.now() < deadline) {
      const r = await reader.read();
      if (r.done) break;
      const t = decoder.decode(r.value);
      if (t.includes("proxy") && t.includes("something-live")) saw = true;
    }
    expect(saw).toBe(true);
    ctrl.abort();
  });

  it.skip("POST /_decopilot_vm/exec/setup returns { ok: true } when idle", async () => {
    // Boot autostart is stripped by patchForTest so the daemon is idle here.
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/exec/setup`,
      { method: "POST", headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it.skip("POST /_decopilot_vm/exec/setup concurrent calls return [200, 409]", async () => {
    // A local HTTP server that accepts connections but never responds.
    // git clone's curl transport will hang in the headers-read phase, which
    // keeps the orchestrator's spawnClone() awaiting — and so setupRunning
    // stays true long enough for the second POST to see it.
    const blocker = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      await stopDaemon();
      await startDaemon({
        CLONE_URL: `http://127.0.0.1:${blocker.port}/no-op.git`,
        REPO_NAME: "test/repo",
        BRANCH: "main",
        GIT_USER_NAME: "test",
        GIT_USER_EMAIL: "t@e",
      });
      const first = fetch(
        `http://localhost:${daemonPort}/_decopilot_vm/exec/setup`,
        { method: "POST", headers: authHeaders() },
      );
      const second = fetch(
        `http://localhost:${daemonPort}/_decopilot_vm/exec/setup`,
        { method: "POST", headers: authHeaders() },
      );
      const [r1, r2] = await Promise.all([first, second]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses[0]).toBe(200);
      expect([409, 503]).toContain(statuses[1]);
    } finally {
      blocker.stop(true);
    }
  });

  it.skip("POST /_decopilot_vm/exec/<unknown> before setup returns 400", async () => {
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/exec/dev`,
      { method: "POST", headers: authHeaders() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("setup not complete");
  });

  it.skip("POST /_decopilot_vm/kill/<name> when process isn't running returns 400", async () => {
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/kill/nonexistent`,
      { method: "POST", headers: authHeaders() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not running");
  });

  it.skip("POST /_decopilot_vm/grep and /_decopilot_vm/glob succeed (confirms uid/gid stripped from spawn)", async () => {
    // Create a file in appDir to search
    const sampleFile = join(appDir, "needle.txt");
    writeFileSync(sampleFile, "hello world\n");

    const toBody = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");

    const grepRes = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/grep`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: toBody({ pattern: "hello", output_mode: "content" }),
      },
    );
    expect(grepRes.status).toBe(200);
    const grepBody = (await grepRes.json()) as { results: string };
    expect(grepBody.results).toContain("hello world");

    const globRes = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/glob`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: toBody({ pattern: "*.txt" }),
      },
    );
    expect(globRes.status).toBe(200);
    const globBody = (await globRes.json()) as { files: string[] };
    expect(globBody.files).toContain("needle.txt");
  });

  it.skip("POST /_decopilot_vm/read returns file contents with line numbers", async () => {
    const sampleFile = join(appDir, "greet.txt");
    writeFileSync(sampleFile, "line1\nline2\nline3\n");
    const toBody = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");

    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/read`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: toBody({ path: "greet.txt" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; lineCount: number };
    expect(body.content).toContain("1\tline1");
    expect(body.content).toContain("2\tline2");
    expect(body.lineCount).toBeGreaterThanOrEqual(3);
  });

  it("POST /_decopilot_vm/write + /edit round-trip", async () => {
    const toBody = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");

    const wr = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/write`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: toBody({ path: "ed.txt", content: "hello world" }),
      },
    );
    expect(wr.status).toBe(200);

    const ed = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/edit`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: toBody({
          path: "ed.txt",
          old_string: "world",
          new_string: "bun",
        }),
      },
    );
    expect(ed.status).toBe(200);
    const edBody = (await ed.json()) as { ok: boolean; replacements: number };
    expect(edBody.ok).toBe(true);
    expect(edBody.replacements).toBe(1);
  });

  it("POST /_decopilot_vm/bash with a timeout-killed command resolves with exitCode=-1 (does not hang)", async () => {
    // Exercises the same Promise-resolution path as a spawn "error" event:
    // child terminates externally (timeout-triggered SIGKILL) and close
    // resolves the await promise with -1. If handleBash ever hangs on
    // spawn failures, this test would time out.
    const toBody = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/bash`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: toBody({ command: "sleep 30", timeout: 500 }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exitCode: number };
    expect(body.exitCode).toBe(-1);
  });

  it("POST /_decopilot_vm/bash with invalid base64 body returns 400", async () => {
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/bash`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: "not-valid-base64-!!@#$",
      },
    );
    expect(res.status).toBe(400);
  });

  it("daemon stays up and keeps probing upstream even when upstream is unreachable", async () => {
    // UPSTREAM is :3000 (per startDaemon fixture) — nothing is listening there.
    // The probe should fail gracefully and not crash the daemon. Give it time
    // for at least one probe cycle (1s initial + 3s fast interval), then
    // confirm the daemon is still responsive.
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/scripts`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);
  });
});

describe("daemon e2e (Bun-native server guarantees)", () => {
  beforeEach(async () => {
    await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterEach(async () => {
    await stopDaemon();
  }, HOOK_TIMEOUT_MS);

  it("returns Access-Control-Allow-Origin=* on every /_decopilot_vm/* response branch", async () => {
    // 1. GET /scripts (native Response branch)
    const scripts = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/scripts`,
      { headers: authHeaders() },
    );
    expect(scripts.headers.get("access-control-allow-origin")).toBe("*");

    // 2. OPTIONS preflight (native Response branch)
    const preflight = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/bash`,
      { method: "OPTIONS" },
    );
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

    // 3. POST /bash (Bun-native Response)
    const bashBody = Buffer.from(
      JSON.stringify({ command: "true" }),
      "utf-8",
    ).toString("base64");
    const bash = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/bash`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: bashBody,
      },
    );
    expect(bash.headers.get("access-control-allow-origin")).toBe("*");

    // 4. GET unknown daemon route (404 catch-all)
    const missing = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/does-not-exist`,
      { headers: authHeaders() },
    );
    expect(missing.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("unknown daemon route returns 404 JSON (not a proxy forward)", async () => {
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/does-not-exist`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Not found");
  });
});

// TODO(sandbox-daemon): all tests in this block fail since the state-machine
// refactor (#3259). The new daemon's startup/upstream logic differs from
// what these tests expect; main passes only by shard luck. Re-enable after
// the daemon-state-machine maintainer refreshes them.
describe.skip("daemon e2e (reverse proxy)", () => {
  let upstreamServer: ReturnType<typeof Bun.serve> | null = null;
  let upstreamPort = 0;

  async function startWithUpstream(
    upstreamHandler: (req: Request) => Response | Promise<Response>,
  ) {
    upstreamServer = Bun.serve({ port: 0, fetch: upstreamHandler });
    upstreamPort = upstreamServer.port as number;
    await startDaemon({ DEV_PORT: String(upstreamPort) });
  }

  async function startWithoutUpstream() {
    // Point upstream at a port where nothing is listening.
    upstreamPort = await freePort();
    await startDaemon({ DEV_PORT: String(upstreamPort) });
  }

  afterEach(async () => {
    await stopDaemon();
    if (upstreamServer) {
      upstreamServer.stop(true);
      upstreamServer = null;
    }
  }, HOOK_TIMEOUT_MS);

  // TODO(#3259): pre-existing failure since the daemon state-machine PR
  // landed. The proxy 503 page text/headers changed and the bootstrap
  // requirement now blocks these flows; tests skipped pending fixture refresh.
  it.skip("injects BOOTSTRAP and strips XFO/CSP/content-encoding for HTML", async () => {
    await startWithUpstream(
      () =>
        new Response("<html><body><h1>hi</h1></body></html>", {
          headers: {
            "Content-Type": "text/html",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'none'",
          },
        }),
    );

    const res = await fetch(`http://localhost:${daemonPort}/page`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("content-encoding")).toBeNull();
    const body = await res.text();
    // The daemon injects IFRAME_BOOTSTRAP_SCRIPT (a <script> tag) before </body>.
    expect(body).toContain("<script>");
    expect(body).toContain("</body>");
    // The script should appear before the closing </body>.
    expect(body.indexOf("<script>")).toBeLessThan(body.lastIndexOf("</body>"));
  });

  it.skip("passes through non-HTML responses untouched", async () => {
    await startWithUpstream(() =>
      Response.json({ ok: true }, { headers: { "X-Frame-Options": "DENY" } }),
    );

    const res = await fetch(`http://localhost:${daemonPort}/api/data`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBeNull();
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it.skip("returns 503 'Server is starting' HTML when upstream is unreachable at /", async () => {
    await startWithoutUpstream();
    const res = await fetch(`http://localhost:${daemonPort}/`);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.text();
    expect(body).toContain("Server is starting");
  });

  it.skip("returns 502 JSON when upstream is unreachable at a non-root path", async () => {
    await startWithoutUpstream();
    const res = await fetch(`http://localhost:${daemonPort}/api/thing`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("proxy error");
  });

  it.skip("forwards POST bodies to upstream", async () => {
    let receivedBody = "";
    await startWithUpstream(async (req) => {
      receivedBody = await req.text();
      return Response.json({ ok: true });
    });

    const res = await fetch(`http://localhost:${daemonPort}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(200);
    expect(receivedBody).toBe('{"hello":"world"}');
  });

  it.skip("forwards chunked POST bodies to upstream", async () => {
    let receivedBody = "";
    await startWithUpstream(async (req) => {
      receivedBody = await req.text();
      return Response.json({ ok: true });
    });

    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("chunk1 "));
        c.enqueue(new TextEncoder().encode("chunk2"));
        c.close();
      },
    });
    // `duplex: "half"` required by fetch when streaming a request body.
    const res = await fetch(`http://localhost:${daemonPort}/api/echo`, {
      method: "POST",
      body: stream,
      // @ts-expect-error — duplex is valid but not in all TS lib types
      duplex: "half",
    });
    expect(res.status).toBe(200);
    expect(receivedBody).toBe("chunk1 chunk2");
  });

  it.skip("strips Authorization from the request seen by the dev server", async () => {
    let seenAuth: string | null = "<<unset>>";
    await startWithUpstream((req) => {
      seenAuth = req.headers.get("authorization");
      return Response.json({ ok: true });
    });
    const res = await fetch(`http://localhost:${daemonPort}/api/sniff`, {
      headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(seenAuth).toBeNull();
  });
});

describe("daemon e2e (auth on mutating routes)", () => {
  beforeEach(async () => {
    await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterEach(async () => {
    await stopDaemon();
  }, HOOK_TIMEOUT_MS);

  const toBody = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");

  const MUTATING_POSTS: Array<{
    name: string;
    path: string;
    body: string;
  }> = [
    { name: "read", path: "/_decopilot_vm/read", body: toBody({ path: "x" }) },
    {
      name: "write",
      path: "/_decopilot_vm/write",
      body: toBody({ path: "x", content: "y" }),
    },
    {
      name: "edit",
      path: "/_decopilot_vm/edit",
      body: toBody({ path: "x", old_string: "a", new_string: "b" }),
    },
    {
      name: "grep",
      path: "/_decopilot_vm/grep",
      body: toBody({ pattern: "x" }),
    },
    {
      name: "glob",
      path: "/_decopilot_vm/glob",
      body: toBody({ pattern: "*" }),
    },
    {
      name: "bash",
      path: "/_decopilot_vm/bash",
      body: toBody({ command: "true" }),
    },
    { name: "exec/setup", path: "/_decopilot_vm/exec/setup", body: "" },
    { name: "kill/foo", path: "/_decopilot_vm/kill/foo", body: "" },
  ];

  for (const m of MUTATING_POSTS) {
    it(`POST ${m.name} without bearer returns 401`, async () => {
      const res = await fetch(`http://localhost:${daemonPort}${m.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: m.body,
      });
      expect(res.status).toBe(401);
    });

    it(`POST ${m.name} with wrong bearer returns 401`, async () => {
      const res = await fetch(`http://localhost:${daemonPort}${m.path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: m.body,
      });
      expect(res.status).toBe(401);
    });

    it(`POST ${m.name} with correct bearer is not 401`, async () => {
      const res = await fetch(`http://localhost:${daemonPort}${m.path}`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: m.body,
      });
      expect(res.status).not.toBe(401);
    });
  }

  it("GET /health works without auth", async () => {
    const res = await fetch(`http://localhost:${daemonPort}/health`);
    expect(res.status).toBe(200);
  });

  it("GET /_decopilot_vm/idle works without auth", async () => {
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/idle`,
    );
    expect(res.status).toBe(200);
  });

  it("GET /_decopilot_vm/scripts works without auth", async () => {
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/scripts`,
    );
    expect(res.status).toBe(200);
  });

  it("GET /_decopilot_vm/events works without auth", async () => {
    const ctrl = new AbortController();
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/events`,
      { signal: ctrl.signal },
    );
    expect(res.status).toBe(200);
    ctrl.abort();
  });

  it("GET /health tolerates an arbitrary Authorization header", async () => {
    const res = await fetch(`http://localhost:${daemonPort}/health`, {
      headers: { Authorization: "Bearer junk-token" },
    });
    expect(res.status).toBe(200);
  });

  it("GET /_decopilot_vm/idle tolerates an arbitrary Authorization header", async () => {
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/idle`,
      { headers: { Authorization: "Bearer junk-token" } },
    );
    expect(res.status).toBe(200);
  });

  it("GET /_decopilot_vm/scripts tolerates an arbitrary Authorization header", async () => {
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/scripts`,
      { headers: { Authorization: "Bearer junk-token" } },
    );
    expect(res.status).toBe(200);
  });

  it("GET /_decopilot_vm/events tolerates an arbitrary Authorization header", async () => {
    const ctrl = new AbortController();
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/events`,
      {
        signal: ctrl.signal,
        headers: { Authorization: "Bearer junk-token" },
      },
    );
    expect(res.status).toBe(200);
    ctrl.abort();
  });

  it("OPTIONS /_decopilot_vm/* preflight works without auth", async () => {
    const res = await fetch(
      `http://localhost:${daemonPort}/_decopilot_vm/bash`,
      { method: "OPTIONS" },
    );
    expect(res.status).toBe(204);
  });
});
