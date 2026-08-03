/**
 * Daemon conformance suite — CORE (auth, config, fs, tasks, orgfs, smoke).
 *
 * Spawns the daemon under test (see daemon.e2e.helpers.ts — swap the binary via
 * DAEMON_E2E_CMD) and exercises real HTTP/SSE endpoints. Every assertion is a
 * black-box contract; no daemon source is imported. Git/exec, reverse-proxy,
 * and dispatch live in sibling daemon.e2e.*.test.ts files.
 *
 * Privilege note: some daemon paths (gitSync) request a uid/gid=1000 drop, but
 * the daemon runs under Bun, which silently ignores spawn uid/gid — so the
 * suite runs as the invoking (non-root) user. A reimplementation that actually
 * honored uid/gid while running as a different user on Linux would EPERM in the
 * git routes; that's a runtime quirk these tests lean on, not a guaranteed part
 * of the contract.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { retry } from "@decocms/shared/std";

import {
  authHeaders,
  type Daemon,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  readSseUntil,
  resolveDaemonCmd,
  startDaemon,
  stopDaemon,
  url,
  writeRepoFile,
} from "./daemon.e2e.helpers";

const toBody = (obj: unknown) => JSON.stringify(obj);

// --- Swappable spawn target (no daemon needed) -------------------------------

describe("daemon e2e: swappable spawn target", () => {
  it("defaults to the built Go daemon binary when DAEMON_E2E_CMD is unset", () => {
    const cmd = resolveDaemonCmd(undefined);
    expect(cmd.length).toBe(1);
    expect(cmd[0]).toMatch(/daemon-go[\\/]bin[\\/]daemon$/);
  });

  it("parses a JSON-array DAEMON_E2E_CMD verbatim", () => {
    expect(resolveDaemonCmd('["./target/release/daemon", "--flag x"]')).toEqual(
      ["./target/release/daemon", "--flag x"],
    );
  });

  it("falls back to whitespace-split for a plain string", () => {
    expect(resolveDaemonCmd("bun /abs/daemon.js")).toEqual([
      "bun",
      "/abs/daemon.js",
    ]);
  });
});

// --- Harness self-check: readSseUntil must be deadline-bounded ---------------

describe("daemon e2e: readSseUntil is deadline-bounded", () => {
  it("rejects within the deadline on a stream that never emits or closes", async () => {
    // An upstream that accepts the connection and then stalls forever — the
    // worst case for an unbounded `reader.read()`.
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              /* never enqueue, never close */
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    try {
      const startedAt = Date.now();
      await expect(
        readSseUntil(`http://localhost:${server.port}/`, {
          predicate: () => false,
          deadlineMs: 300,
        }),
      ).rejects.toThrow(/within 300ms/);
      // Bounded — must not stall until Bun's global test timeout.
      expect(Date.now() - startedAt).toBeLessThan(5000);
    } finally {
      server.stop(true);
    }
  });
});

// --- Smoke / CORS / no-auth GETs (shared daemon — read-only) -----------------

describe("daemon e2e: smoke, CORS, dual-prefix", () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  it("GET /_sandbox/scripts returns { scripts: [] } before discovery", async () => {
    const res = await fetch(url(d, "/_sandbox/scripts"), {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { scripts: string[] };
    expect(body.scripts).toEqual([]);
  });

  it("serves no-auth GETs and sets CORS on the native branch", async () => {
    const res = await fetch(url(d, "/_sandbox/scripts"));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("GET /_sandbox/events streams an SSE status event on connect", async () => {
    const { res } = await readSseUntil(url(d, "/_sandbox/events"), {
      headers: authHeaders(),
      predicate: (acc) =>
        acc.includes("event: status") && acc.includes("data:"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
  });

  it("OPTIONS preflight returns 204 + CORS headers (no auth)", async () => {
    const res = await fetch(url(d, "/_sandbox/bash"), { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "Authorization",
    );
  });

  it("sets Access-Control-Allow-Origin=* on every response branch", async () => {
    const scripts = await fetch(url(d, "/_sandbox/scripts"), {
      headers: authHeaders(),
    });
    expect(scripts.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await fetch(url(d, "/_sandbox/bash"), {
      method: "OPTIONS",
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    const handled = await fetch(url(d, "/_sandbox/bash"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({}),
    });
    expect(handled.status).toBe(400);
    expect(handled.headers.get("access-control-allow-origin")).toBe("*");
    const missing = await fetch(url(d, "/_sandbox/does-not-exist"), {
      headers: authHeaders(),
    });
    expect(missing.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("unknown daemon route returns 404 JSON (not a proxy forward)", async () => {
    const res = await fetch(url(d, "/_sandbox/does-not-exist"), {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Not found");
  });

  // Dual-serve compat (T11): both the canonical /_sandbox/* and legacy
  // /_decopilot_vm/* prefixes are served for one release window.
  it("GET /_sandbox/idle and legacy /_decopilot_vm/idle both work without auth", async () => {
    expect((await fetch(url(d, "/_sandbox/idle"))).status).toBe(200);
    expect((await fetch(url(d, "/_decopilot_vm/idle"))).status).toBe(200);
  });

  it("POST /_decopilot_vm/bash (legacy prefix) with bearer is not 401/404", async () => {
    const res = await fetch(url(d, "/_decopilot_vm/bash"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ command: "true" }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it("GET /health works without auth and tolerates an arbitrary Authorization header", async () => {
    expect((await fetch(url(d, "/health"))).status).toBe(200);
    const withJunk = await fetch(url(d, "/health"), {
      headers: { Authorization: "Bearer junk-token" },
    });
    expect(withJunk.status).toBe(200);
  });

  it("no-auth GETs tolerate an arbitrary Authorization header", async () => {
    for (const path of ["/_sandbox/idle", "/_sandbox/scripts"]) {
      const res = await fetch(url(d, path), {
        headers: { Authorization: "Bearer junk-token" },
      });
      expect(res.status).toBe(200);
    }
  });
});

// --- bash (shared daemon) ----------------------------------------------------

describe("daemon e2e: bash", () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  it("executes a command and returns stdout", async () => {
    const res = await fetch(url(d, "/_sandbox/bash"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ command: "echo hello-world" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stdout: string; exitCode: number };
    expect(body.stdout.trim()).toBe("hello-world");
    expect(body.exitCode).toBe(0);
  });

  it("a timeout-killed command resolves with exitCode=-1 (does not hang)", async () => {
    const res = await fetch(url(d, "/_sandbox/bash"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ command: "sleep 30", timeout: 500 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exitCode: number };
    expect(body.exitCode).toBe(-1);
  });

  it("invalid JSON body returns 400", async () => {
    const res = await fetch(url(d, "/_sandbox/bash"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: "not-valid-json-!!@#$",
    });
    expect(res.status).toBe(400);
  });

  it("background mode returns a taskId + status", async () => {
    const res = await fetch(url(d, "/_sandbox/bash"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ command: "true", mode: "background" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskId: string; status: string };
    expect(typeof body.taskId).toBe("string");
    expect(body.taskId.length).toBeGreaterThan(0);
  });
});

// --- fs (shared daemon; each test uses a unique path) ------------------------

describe("daemon e2e: fs", () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  it("write + read round-trip returns line-numbered content", async () => {
    await writeRepoFile(d, "greet.txt", "line1\nline2\nline3\n");
    const res = await fetch(url(d, "/_sandbox/read"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ path: "greet.txt" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      content: string;
      lineCount: number;
    };
    expect(body.kind).toBe("text");
    expect(body.content).toContain("1\tline1");
    expect(body.content).toContain("2\tline2");
    expect(body.lineCount).toBeGreaterThanOrEqual(3);
  });

  it("write + edit round-trip", async () => {
    await writeRepoFile(d, "ed.txt", "hello world");
    const ed = await fetch(url(d, "/_sandbox/edit"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ path: "ed.txt", old_string: "world", new_string: "bun" }),
    });
    expect(ed.status).toBe(200);
    const body = (await ed.json()) as { ok: boolean; replacements: number };
    expect(body.ok).toBe(true);
    expect(body.replacements).toBe(1);
  });

  it("edit of a missing string returns 400", async () => {
    await writeRepoFile(d, "ed-missing.txt", "abc");
    const res = await fetch(url(d, "/_sandbox/edit"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({
        path: "ed-missing.txt",
        old_string: "zzz",
        new_string: "q",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("unlink reports existed=true then existed=false", async () => {
    await writeRepoFile(d, "doomed.txt", "x");
    const first = await fetch(url(d, "/_sandbox/unlink"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ path: "doomed.txt" }),
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { existed: boolean }).existed).toBe(true);
    const second = await fetch(url(d, "/_sandbox/unlink"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ path: "doomed.txt" }),
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { existed: boolean }).existed).toBe(false);
  });

  it("mkdir + rename happy paths", async () => {
    const mk = await fetch(url(d, "/_sandbox/mkdir"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ path: "subdir" }),
    });
    expect(mk.status).toBe(200);
    await writeRepoFile(d, "from.txt", "movable");
    const rn = await fetch(url(d, "/_sandbox/rename"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ from: "from.txt", to: "subdir/to.txt" }),
    });
    expect(rn.status).toBe(200);
    expect(((await rn.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("mkdir rejects a path escaping the root", async () => {
    const res = await fetch(url(d, "/_sandbox/mkdir"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ path: "../escape" }),
    });
    expect(res.status).toBe(400);
  });

  it("glob finds a written file (no ripgrep needed)", async () => {
    await writeRepoFile(d, "needle.txt", "hay\n");
    const res = await fetch(url(d, "/_sandbox/glob"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ pattern: "*.txt" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: string[] };
    expect(body.files).toContain("needle.txt");
  });

  it("grep finds matching content (strict in CI; tolerant locally without ripgrep)", async () => {
    await writeRepoFile(d, "grepme.txt", "find-this-token\n");
    const res = await fetch(url(d, "/_sandbox/grep"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ pattern: "find-this-token", output_mode: "content" }),
    });
    // CI installs ripgrep (see sandbox-daemon.yml), so there the route MUST
    // work — no 500 escape hatch, otherwise a grep regression passes silently.
    if (process.env.CI || res.status === 200) {
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: string };
      expect(body.results).toContain("find-this-token");
    } else {
      // Local machine without ripgrep: the route surfaces a 500 "grep unavailable".
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain("grep");
    }
  });
});

// --- url transfer SSRF gate --------------------------------------------------

// /write_from_url and /upload_to_url fetch a caller-supplied URL from inside
// the pod. The allowlist comes from boot env, never the request body.
describe("daemon e2e: url transfer SSRF gate", () => {
  const post = (d: Daemon, path: string, body: unknown) =>
    fetch(url(d, path), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify(body),
    });

  describe("with no allowlist configured", () => {
    let d: Daemon;
    beforeEach(async () => {
      d = await startDaemon();
    }, HOOK_TIMEOUT_MS);
    afterEach(async () => {
      await stopDaemon(d);
    }, HOOK_TIMEOUT_MS);

    it("write_from_url denies every host (fail closed)", async () => {
      const res = await post(d, "/_sandbox/write_from_url", {
        path: "out.bin",
        url: "https://s3.example.com/object",
      });
      expect(res.status).toBe(400);
    });

    it("upload_to_url denies every host (fail closed)", async () => {
      await writeRepoFile(d, "up.txt", "payload\n");
      const res = await post(d, "/_sandbox/upload_to_url", {
        path: "up.txt",
        url: "https://s3.example.com/object",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("with an allowlist configured", () => {
    let d: Daemon;
    beforeEach(async () => {
      d = await startDaemon({ OFFLOAD_ALLOWED_HOSTS: "s3.example.com" });
    }, HOOK_TIMEOUT_MS);
    afterEach(async () => {
      await stopDaemon(d);
    }, HOOK_TIMEOUT_MS);

    for (const [name, target] of [
      ["an unlisted host", "https://evil.example.com/x"],
      ["a suffix of a listed host", "https://s3.example.com.evil.net/x"],
      ["ip-literal loopback", "https://127.0.0.1/x"],
      ["ipv6 loopback", "https://[::1]/x"],
      ["cloud metadata", "https://169.254.169.254/latest/meta-data/"],
      ["plain http on a listed host", "http://s3.example.com/x"],
      ["a non-http scheme", "file:///etc/passwd"],
    ] as const) {
      it(`write_from_url rejects ${name}`, async () => {
        const res = await post(d, "/_sandbox/write_from_url", {
          path: "out.bin",
          url: target,
        });
        expect(res.status).toBe(400);
      });
    }
  });

  describe("with a live loopback origin allowed", () => {
    let d: Daemon;
    let origin: ReturnType<typeof Bun.serve>;
    beforeEach(async () => {
      origin = Bun.serve({
        port: 0,
        fetch: (req) =>
          new URL(req.url).pathname === "/redirect"
            ? Response.redirect(
                "https://169.254.169.254/latest/meta-data/",
                302,
              )
            : new Response("payload-bytes"),
      });
      d = await startDaemon({
        OFFLOAD_ALLOWED_HOSTS: "127.0.0.1",
        OFFLOAD_ALLOW_SAME_HOST_DEV: "1",
      });
    }, HOOK_TIMEOUT_MS);
    afterEach(async () => {
      origin.stop(true);
      await stopDaemon(d);
    }, HOOK_TIMEOUT_MS);

    it("write_from_url fetches from the allowed host", async () => {
      const res = await post(d, "/_sandbox/write_from_url", {
        path: "fetched.txt",
        url: `http://127.0.0.1:${origin.port}/object`,
      });
      expect(res.status).toBe(200);
      const read = await fetch(url(d, "/_sandbox/read"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ path: "fetched.txt" }),
      });
      expect(await read.text()).toContain("payload-bytes");
    });

    it("write_from_url does not follow a redirect off the allowlist", async () => {
      const res = await post(d, "/_sandbox/write_from_url", {
        path: "redirected.txt",
        url: `http://127.0.0.1:${origin.port}/redirect`,
      });
      expect(res.status).not.toBe(200);
      // Assert on the *reason*, not just the status. A daemon that happily
      // follows the 302 also fails `not.toBe(200)` — on a dev laptop the
      // connection to 169.254.169.254 is refused instantly and the 502 reads
      // like a pass, while on a cloud runner (where that IP is the real
      // metadata endpoint) the same code hangs. Only the gate message proves
      // the hop was rejected before any socket was opened.
      expect(await res.text()).toContain("host not allowed");
    });
  });
});

// --- config (fresh daemon per test — mutates config/token) -------------------

describe("daemon e2e: config", () => {
  let d: Daemon;
  beforeEach(async () => {
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterEach(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  it("GET /_sandbox/config on a fresh daemon returns null config + empty envKeys", async () => {
    const res = await fetch(url(d, "/_sandbox/config"), {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: unknown;
      envKeys: string[];
      ready: boolean;
      orchestrator: { running: boolean; pending: number };
    };
    expect(body.config).toBeNull();
    expect(body.envKeys).toEqual([]);
    expect(body.ready).toBe(false);
    expect(body.orchestrator).toEqual({ running: false, pending: 0 });
  });

  it("POST /_sandbox/config bootstraps and reports the transition", async () => {
    const res = await fetch(url(d, "/_sandbox/config"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ application: { packageManager: { name: "npm" } } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transition: string; config: unknown };
    expect(body.transition).toBe("bootstrap");
    const get = await fetch(url(d, "/_sandbox/config"), {
      headers: authHeaders(),
    });
    const cfg = (await get.json()) as {
      config: { application?: { packageManager?: { name: string } } };
    };
    expect(cfg.config.application?.packageManager?.name).toBe("npm");
  });

  it("POST /_sandbox/config with invalid JSON returns 400", async () => {
    const res = await fetch(url(d, "/_sandbox/config"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: "}{not json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /_sandbox/config with a non-object body returns 400", async () => {
    const res = await fetch(url(d, "/_sandbox/config"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: "null",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("object");
  });

  it("rejects changing the immutable cloneUrl with 409", async () => {
    const first = await fetch(url(d, "/_sandbox/config"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({
        git: { repository: { cloneUrl: "https://example.com/a.git" } },
      }),
    });
    expect(first.status).toBe(200);
    const second = await fetch(url(d, "/_sandbox/config"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({
        git: { repository: { cloneUrl: "https://example.com/b.git" } },
      }),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toContain("immutable");
  });

  it("env keys round-trip via GET (keys only, no values)", async () => {
    const res = await fetch(url(d, "/_sandbox/config"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ env: { FOO: "bar", BAZ: "qux" } }),
    });
    expect(res.status).toBe(200);
    const get = await fetch(url(d, "/_sandbox/config"), {
      headers: authHeaders(),
    });
    const body = (await get.json()) as { envKeys: string[] };
    expect(body.envKeys).toEqual(["BAZ", "FOO"]);
  });

  it("auth.rotateToken with a too-short token returns 400", async () => {
    const res = await fetch(url(d, "/_sandbox/config"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ auth: { rotateToken: "tooshort" } }),
    });
    expect(res.status).toBe(400);
  });
});

// --- tasks (fresh daemon per test) -------------------------------------------

describe("daemon e2e: tasks", () => {
  let d: Daemon;
  beforeEach(async () => {
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterEach(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  async function spawnBackground(command: string): Promise<string> {
    const res = await fetch(url(d, "/_sandbox/bash"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ command, mode: "background" }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { taskId: string }).taskId;
  }

  async function waitForTaskToStop(id: string): Promise<void> {
    await retry(
      async () => {
        const response = await fetch(url(d, `/_sandbox/tasks/${id}`), {
          headers: authHeaders(),
        });
        if (!response.ok) {
          throw new Error(`task ${id} returned ${response.status}`);
        }
        const task = (await response.json()) as { status: string };
        if (task.status === "running") {
          throw new Error(`task ${id} is still running`);
        }
      },
      {
        maxAttempts: 40,
        minTimeout: 50,
        maxTimeout: 50,
        jitter: 0,
      },
    );
  }

  it("GET /_sandbox/tasks lists a running background task", async () => {
    const id = await spawnBackground("sleep 10");
    const res = await fetch(url(d, "/_sandbox/tasks?status=running"), {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { id: string }[] };
    expect(body.tasks.some((t) => t.id === id)).toBe(true);
  });

  it("GET /_sandbox/tasks/:id returns a summary; unknown id is 404", async () => {
    const id = await spawnBackground("sleep 10");
    const res = await fetch(url(d, `/_sandbox/tasks/${id}`), {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stdout: string; truncated: boolean };
    expect(typeof body.stdout).toBe("string");
    const missing = await fetch(url(d, "/_sandbox/tasks/does-not-exist"), {
      headers: authHeaders(),
    });
    expect(missing.status).toBe(404);
  });

  it("kill a running task → ok; killing again → 400 not running", async () => {
    const id = await spawnBackground("sleep 30");
    const kill = await fetch(url(d, `/_sandbox/tasks/${id}/kill`), {
      method: "POST",
      headers: authHeaders(),
    });
    expect(kill.status).toBe(200);
    expect(((await kill.json()) as { ok: boolean }).ok).toBe(true);
    await waitForTaskToStop(id);
    const again = await fetch(url(d, `/_sandbox/tasks/${id}/kill`), {
      method: "POST",
      headers: authHeaders(),
    });
    expect(again.status).toBe(400);
  });

  it("POST /_sandbox/tasks/kill-all returns a killed count", async () => {
    await spawnBackground("sleep 30");
    const res = await fetch(url(d, "/_sandbox/tasks/kill-all"), {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; killed: number };
    expect(body.ok).toBe(true);
    expect(body.killed).toBeGreaterThanOrEqual(1);
  });

  it("GET /_sandbox/tasks/:id/stream replays output then ends", async () => {
    const id = await spawnBackground("echo streamed-line");
    const { res } = await readSseUntil(url(d, `/_sandbox/tasks/${id}/stream`), {
      headers: authHeaders(),
      predicate: (acc) => acc.includes("event: end"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("DELETE a finished task → ok; deleting a running task → 400", async () => {
    // Running task → 400.
    const running = await spawnBackground("sleep 30");
    const delRunning = await fetch(url(d, `/_sandbox/tasks/${running}`), {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(delRunning.status).toBe(400);

    // Finished task → ok. Spawn a fast task and wait for it to leave "running".
    const quick = await spawnBackground("true");
    await waitForTaskToStop(quick);
    const delDone = await fetch(url(d, `/_sandbox/tasks/${quick}`), {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(delDone.status).toBe(200);
    expect(((await delDone.json()) as { ok: boolean }).ok).toBe(true);
  });
});

// --- orgfs-config ------------------------------------------------------------

describe("daemon e2e: orgfs-config", () => {
  const validConfig = toBody({
    baseUrl: "https://cluster.example",
    orgSlug: "acme",
    token: "fs-scoped-token",
    mounts: [{ volume: "skills", path: "skills", readonly: true }],
  });

  it(
    "returns { written: false } when no sidecar path is configured",
    async () => {
      const d = await startDaemon();
      try {
        const res = await fetch(url(d, "/_sandbox/orgfs-config"), {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: validConfig,
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { written: boolean }).written).toBe(
          false,
        );
      } finally {
        await stopDaemon(d);
      }
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "invalid org-fs config returns 400",
    async () => {
      const d = await startDaemon();
      try {
        const res = await fetch(url(d, "/_sandbox/orgfs-config"), {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: toBody({ not: "a valid org-fs config" }),
        });
        expect(res.status).toBe(400);
      } finally {
        await stopDaemon(d);
      }
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "writes the config to the sidecar control path when configured",
    async () => {
      const sidecarDir = mkdtempSync(join(tmpdir(), "daemon-e2e-orgfs-"));
      const sidecarPath = join(sidecarDir, "orgfs.json");
      const d = await startDaemon({ ORGFS_SIDECAR_CONFIG_PATH: sidecarPath });
      try {
        const res = await fetch(url(d, "/_sandbox/orgfs-config"), {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: validConfig,
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { written: boolean };
        // With a sidecar path wired and a valid config, the relay must write it.
        expect(body.written).toBe(true);
        expect(readFileSync(sidecarPath, "utf8").length).toBeGreaterThan(0);
      } finally {
        await stopDaemon(d);
        rmSync(sidecarDir, { recursive: true, force: true });
      }
    },
    HOOK_TIMEOUT_MS,
  );
});

// --- auth matrix on mutating routes (shared daemon) --------------------------

describe("daemon e2e: auth on mutating routes", () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  const MUTATING: Array<{
    name: string;
    path: string;
    method?: string;
    body: string;
  }> = [
    { name: "read", path: "/_sandbox/read", body: toBody({ path: "x" }) },
    {
      name: "write",
      path: "/_sandbox/write",
      body: toBody({ path: "x", content: "y" }),
    },
    {
      name: "edit",
      path: "/_sandbox/edit",
      body: toBody({ path: "x", old_string: "a", new_string: "b" }),
    },
    { name: "unlink", path: "/_sandbox/unlink", body: toBody({ path: "x" }) },
    { name: "mkdir", path: "/_sandbox/mkdir", body: toBody({ path: "x" }) },
    {
      name: "rename",
      path: "/_sandbox/rename",
      body: toBody({ from: "a", to: "b" }),
    },
    { name: "grep", path: "/_sandbox/grep", body: toBody({ pattern: "x" }) },
    { name: "glob", path: "/_sandbox/glob", body: toBody({ pattern: "*" }) },
    { name: "bash", path: "/_sandbox/bash", body: toBody({ command: "true" }) },
    {
      name: "config",
      path: "/_sandbox/config",
      body: toBody({ env: { A: "1" } }),
    },
    { name: "orgfs-config", path: "/_sandbox/orgfs-config", body: "{}" },
    {
      name: "git/publish",
      path: "/_sandbox/git/publish",
      body: toBody({ message: "m" }),
    },
    {
      name: "git/discard",
      path: "/_sandbox/git/discard",
      body: toBody({ filepaths: ["x"] }),
    },
    {
      name: "git/rebase",
      path: "/_sandbox/git/rebase",
      body: toBody({ base: "main" }),
    },
    {
      name: "git/status",
      path: "/_sandbox/git/status",
      method: "GET",
      body: "",
    },
    { name: "setup/clone", path: "/_sandbox/setup/clone", body: "" },
    { name: "setup/install", path: "/_sandbox/setup/install", body: "" },
    { name: "setup/start", path: "/_sandbox/setup/start", body: "" },
    { name: "tasks/kill-all", path: "/_sandbox/tasks/kill-all", body: "" },
    {
      name: "dispatch",
      path: "/_sandbox/dispatch",
      body: toBody({ harnessId: "x", input: {} }),
    },
  ];

  for (const m of MUTATING) {
    const method = m.method ?? "POST";
    it(`${method} ${m.name} without bearer → 401`, async () => {
      const res = await fetch(url(d, m.path), {
        method,
        headers: m.body ? { "Content-Type": "application/json" } : {},
        body: m.body || undefined,
      });
      expect(res.status).toBe(401);
    });

    it(`${method} ${m.name} with wrong bearer → 401`, async () => {
      const res = await fetch(url(d, m.path), {
        method,
        headers: {
          Authorization: "Bearer wrong-token",
          ...(m.body ? { "Content-Type": "application/json" } : {}),
        },
        body: m.body || undefined,
      });
      expect(res.status).toBe(401);
    });

    it(`${method} ${m.name} with correct bearer is not 401`, async () => {
      const res = await fetch(url(d, m.path), {
        method,
        headers: m.body ? jsonAuthHeaders() : authHeaders(),
        body: m.body || undefined,
      });
      expect(res.status).not.toBe(401);
    });
  }

  it("DELETE /_sandbox/runs/:id without bearer → 401", async () => {
    const res = await fetch(url(d, "/_sandbox/runs/run-1"), {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});
