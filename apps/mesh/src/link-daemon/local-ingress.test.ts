import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalIngress, type LocalIngress } from "./local-ingress";

let ingress: LocalIngress | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
afterEach(async () => {
  await ingress?.stop();
  upstream?.stop(true);
  ingress = null;
  upstream = null;
});

describe("local-ingress HTTP proxying", () => {
  test("routes <handle>.localhost to the sandbox port", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(`hello from ${new URL(req.url).pathname}`, {
          status: 200,
        });
      },
    });
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: (handle) =>
        handle === "abc" ? (upstream!.port ?? null) : null,
    });
    const res = await fetch(`http://127.0.0.1:${ingress.port}/widget`, {
      headers: { host: `abc.localhost:${ingress.port}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from /widget");
  });

  test("unknown handle (HTTP) → 503 auto-reloading connecting page", async () => {
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => null,
    });
    const res = await fetch(`http://127.0.0.1:${ingress.port}/`, {
      headers: { host: `nope.localhost:${ingress.port}` },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Connecting to sandbox");
    expect(body).toContain("window.location.reload");
  });

  test("unknown handle (WebSocket upgrade) → 404 (no HTML)", async () => {
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => null,
    });
    // A WS upgrade to an unspawned handle must NOT receive the 503 HTML page
    // (a WS client can't parse it) — the upgrade fails and the socket closes.
    const ws = new WebSocket(`ws://nope.localhost:${ingress.port}/`);
    const closeEvent = await new Promise<CloseEvent>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no close within 5s")), 5000);
      ws.addEventListener("close", (e) => {
        clearTimeout(t);
        resolve(e);
      });
    });
    expect(closeEvent.wasClean).toBe(false);
  });

  test("non-localhost host → 404", async () => {
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => 1,
    });
    const res = await fetch(`http://127.0.0.1:${ingress.port}/`, {
      headers: { host: `evil.example.com:${ingress.port}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("local-ingress WS proxying", () => {
  test("forwards WebSocket frames in both directions", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          srv.upgrade(req, { data: {} });
          return undefined;
        }
        return new Response("no", { status: 404 });
      },
      websocket: {
        message(ws, msg) {
          ws.send(`echo:${typeof msg === "string" ? msg : ""}`);
        },
        open() {},
        close() {},
      },
    });
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => upstream!.port ?? null,
    });
    const ws = new WebSocket(`ws://abc.localhost:${ingress.port}/`);
    const got: string[] = [];
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    ws.addEventListener("message", (e) => {
      got.push(typeof e.data === "string" ? e.data : "");
    });
    ws.send("hi");
    for (let i = 0; i < 40 && got.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(got[0]).toBe("echo:hi");
    ws.close();
  });

  test("forwards path and query string to upstream", async () => {
    let seenPath: string | null = null;
    upstream = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          const u = new URL(req.url);
          seenPath = `${u.pathname}${u.search}`;
          srv.upgrade(req, { data: {} });
          return undefined;
        }
        return new Response("no", { status: 404 });
      },
      websocket: { message() {}, open() {}, close() {} },
    });
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => upstream!.port ?? null,
    });
    const ws = new WebSocket(
      `ws://abc.localhost:${ingress.port}/foo?token=hello`,
    );
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    // Give upstream a tick to process its own upgrade and record the path.
    for (let i = 0; i < 40 && seenPath === null; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    // TS narrows closure-mutated `string | null` back to literal `null` at
    // the outer site, which makes `expect().toBe(...)` resolve to its
    // null-only overload. Re-widen via the assertion cast so tsc accepts
    // the comparison while still failing the test loudly on mismatch.
    if ((seenPath as string | null) === null) {
      throw new Error("upstream did not see request in time");
    }
    expect(seenPath as string | null).toBe("/foo?token=hello");
    ws.close();
  });

  test("forwards subprotocol to upstream", async () => {
    let seenProtocol: string | null = null;
    upstream = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          seenProtocol = req.headers.get("sec-websocket-protocol");
          // Bun's srv.upgrade accepts a `headers` option for the response.
          srv.upgrade(req, {
            data: {},
            headers: { "sec-websocket-protocol": "vite-hmr" },
          });
          return undefined;
        }
        return new Response("no", { status: 404 });
      },
      websocket: { message() {}, open() {}, close() {} },
    });
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => upstream!.port ?? null,
    });
    const ws = new WebSocket(`ws://abc.localhost:${ingress.port}/`, "vite-hmr");
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    for (let i = 0; i < 40 && seenProtocol === null; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    // See note on `seenPath` above re: closure-mutation narrowing.
    if ((seenProtocol as string | null) === null) {
      throw new Error("upstream did not see subprotocol in time");
    }
    expect(seenProtocol as string | null).toBe("vite-hmr");
    ws.close();
  });

  test("forwards binary frames in both directions", async () => {
    const received: Array<{ from: "upstream"; data: ArrayBuffer }> = [];
    upstream = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          srv.upgrade(req, { data: {} });
          return undefined;
        }
        return new Response("no", { status: 404 });
      },
      websocket: {
        message(ws, msg) {
          // Echo back as binary regardless of input shape.
          if (typeof msg === "string") {
            ws.send(new TextEncoder().encode(`echo:${msg}`));
          } else {
            // Prepend a marker byte 0xff so the round-trip is observable.
            const buf = msg instanceof ArrayBuffer ? new Uint8Array(msg) : msg;
            const out = new Uint8Array(buf.length + 1);
            out[0] = 0xff;
            out.set(buf, 1);
            ws.send(out);
          }
        },
        open() {},
        close() {},
      },
    });
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => upstream!.port ?? null,
    });
    const ws = new WebSocket(`ws://abc.localhost:${ingress.port}/`);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    ws.addEventListener("message", (e) => {
      if (e.data instanceof ArrayBuffer) {
        received.push({ from: "upstream", data: e.data });
      }
    });
    // Send a binary frame containing bytes 0x01 0x02 0x03.
    ws.send(new Uint8Array([0x01, 0x02, 0x03]));
    for (let i = 0; i < 40 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(received.length).toBe(1);
    const first = received[0];
    if (!first) throw new Error("did not receive expected echo");
    const bytes = new Uint8Array(first.data);
    // Expected: [0xff, 0x01, 0x02, 0x03] — marker + original payload.
    expect(Array.from(bytes)).toEqual([0xff, 0x01, 0x02, 0x03]);
    ws.close();
  });

  test("propagates upstream close code and reason to client", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          srv.upgrade(req, { data: {} });
          return undefined;
        }
        return new Response("no", { status: 404 });
      },
      websocket: {
        open(ws) {
          // Close with a distinctive code/reason as soon as the WS opens.
          ws.close(4321, "deliberate test close");
        },
        message() {},
        close() {},
      },
    });
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => upstream!.port ?? null,
    });
    const ws = new WebSocket(`ws://abc.localhost:${ingress.port}/`);
    const closeEvent = await new Promise<CloseEvent>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e));
    });
    expect(closeEvent.code).toBe(4321);
    expect(closeEvent.reason).toBe("deliberate test close");
  });

  test("closes client with 1011 when upstream is unreachable", async () => {
    const { createServer } = await import("node:net");
    const reserved = createServer();
    await new Promise<void>((resolve) =>
      reserved.listen(0, "127.0.0.1", resolve),
    );
    const closedPort = (reserved.address() as { port: number }).port;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));

    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => closedPort,
    });
    const ws = new WebSocket(`ws://abc.localhost:${ingress.port}/`);
    const closeEvent = await new Promise<CloseEvent>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("no close event within 5s")),
        5000,
      );
      ws.addEventListener("close", (e) => {
        clearTimeout(t);
        resolve(e);
      });
    });
    expect(closeEvent.code).toBe(1011);
  });
});

describe("local-ingress idle timeout (slow, local-only)", () => {
  // A request the ingress proxies can legitimately stay open far longer than
  // Bun.serve's DEFAULT 10s idleTimeout: SSE/streaming chat previews and
  // cold-starting dev servers routinely produce no I/O for >10s. With the
  // default timeout, Bun aborts the inbound (browser→ingress) connection at
  // 10s and logs:
  //   "[Bun.serve]: request timed out after 10 seconds. Pass `idleTimeout` to configure."
  // dropping the user's preview mid-stream. The ingress therefore disables the
  // idle timeout (idleTimeout: 0), matching apps/mesh/src/index.ts:147 and the
  // sandbox daemon's Bun.serve (packages/sandbox/daemon/entry.ts:651). This
  // reproduction waits >10s, so it's skipped in CI (same rationale as the Vite
  // integration test below) and runs locally as the regression guard.
  const SKIP_IN_CI = !!process.env.CI;
  const itOrSkip = SKIP_IN_CI ? test.skip : test;

  itOrSkip(
    "keeps a slow (>10s) proxied response alive instead of timing out at 10s",
    async () => {
      upstream = Bun.serve({
        port: 0,
        idleTimeout: 0, // isolate the assertion to the ingress, not the upstream
        async fetch() {
          // Stay silent past the default 10s idle window before replying.
          await new Promise((r) => setTimeout(r, 12_000));
          return new Response("slow ok", { status: 200 });
        },
      });
      ingress = await startLocalIngress({
        port: 0,
        lookupSandboxPort: () => upstream!.port ?? null,
      });
      const res = await fetch(`http://127.0.0.1:${ingress.port}/slow`, {
        headers: { host: `abc.localhost:${ingress.port}` },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("slow ok");
    },
    20_000,
  );
});

describe("local-ingress + real Vite HMR (integration)", () => {
  const VITE_BOOT_TIMEOUT_MS = 30_000;
  const HMR_HELLO_TIMEOUT_MS = 10_000;
  // Budget for the whole test: Vite boot (≤30s) + HMR hello (≤10s) + setup
  // slack. Bun's default per-test timeout is 5s, so override via the third
  // arg to `test()` below.
  const TEST_TIMEOUT_MS = 60_000;

  // Skip this test in CI. Per CLAUDE.md / TESTING.md, unit tests are "pure
  // logic only. No mocks, no DB, no network." This one spawns a real Vite
  // dev server, which makes it an e2e test by that definition — and in
  // practice it hangs on CI's GitHub-hosted runners (Vite never writes its
  // "Local: …" banner to stdout within 60s, while the same fixture takes
  // ~600ms on a developer machine). The five WS micro-tests above already
  // lock in each capability against deterministic stub upstreams, and the
  // plan's Task 7 (manual browser smoke through live `deco link`) is the
  // user-visible verification. Follow-up: move this to apps/mesh/e2e/.
  const SKIP_IN_CI = !!process.env.CI;
  const itOrSkip = SKIP_IN_CI ? test.skip : test;

  // Resolve the workspace's installed Vite binary at module load time so the
  // spawn below doesn't depend on cwd-based resolution. The fixture is in
  // `mkdtempSync(tmpdir())`, which has no node_modules — `bunx vite` from
  // there would walk up to / and fall back to downloading vite from npm,
  // which hangs CI past any reasonable test timeout.
  //
  // `vite/package.json` is reachable through vite's exports map; from there
  // we derive the absolute path to the bin script. (Using `import.meta.resolve`
  // on `vite/bin/vite.js` is blocked because it isn't in the exports map.)
  const VITE_PKG_URL = import.meta.resolve("vite/package.json");
  const VITE_BIN = new URL("./bin/vite.js", VITE_PKG_URL).pathname;

  let fixtureDir: string | null = null;
  let viteProc: ReturnType<typeof Bun.spawn> | null = null;
  let vitePort = 0;

  async function startVite(): Promise<number> {
    fixtureDir = mkdtempSync(join(tmpdir(), "local-ingress-vite-"));
    writeFileSync(
      join(fixtureDir, "index.html"),
      '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>',
    );
    writeFileSync(join(fixtureDir, "main.js"), "console.log('hi');");
    // Let Vite pick a free port; we'll read it from stdout. Invoke the
    // workspace's vite binary directly under bun — bypassing `bunx` (which
    // would re-resolve vite from the fixture cwd, find no node_modules, and
    // attempt a network install).
    viteProc = Bun.spawn(
      [
        "bun",
        "--bun",
        VITE_BIN,
        "--port",
        "0",
        "--host",
        "127.0.0.1",
        "--strictPort",
        "false",
      ],
      {
        cwd: fixtureDir,
        stdout: "pipe",
        // We don't surface stderr; ignoring it prevents a noisy Vite boot
        // from filling a pipe buffer and stalling port discovery.
        stderr: "ignore",
      },
    );
    // Read stdout until we see "Local:   http://127.0.0.1:PORT".
    // Bun's spawn return type widens stdout to `number | ReadableStream
    // | undefined`; `stdout: "pipe"` above always yields a ReadableStream,
    // but tsc can't infer that, so check both shapes explicitly.
    const stdout = viteProc.stdout;
    if (!stdout || typeof stdout === "number") {
      throw new Error("vite stdout pipe unexpectedly absent");
    }
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + VITE_BOOT_TIMEOUT_MS;
    let buf = "";
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const m = buf.match(/Local:\s+http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) {
          return Number(m[1]);
        }
      }
      throw new Error("Vite did not announce its port within 30s");
    } finally {
      // Release the pipe so the FD doesn't stay pending after kill().
      reader.releaseLock();
    }
  }

  afterEach(async () => {
    try {
      viteProc?.kill();
    } catch (err) {
      console.warn("failed to kill vite proc:", err);
    }
    viteProc = null;
    if (fixtureDir) {
      try {
        rmSync(fixtureDir, { recursive: true, force: true });
      } catch (err) {
        console.warn("failed to remove vite fixture dir:", err);
      }
      fixtureDir = null;
    }
  });

  itOrSkip(
    "HMR client receives the 'connected' welcome through the ingress",
    async () => {
      vitePort = await startVite();
      ingress = await startLocalIngress({
        port: 0,
        lookupSandboxPort: () => vitePort,
      });
      // Mimic exactly what the Vite-injected HMR client does:
      //   new WebSocket(`ws://host/?token=...`, "vite-hmr")
      // Vite ignores unknown tokens by default in 5.x dev mode, so any token
      // is fine for this smoke test; what matters is that path + subprotocol
      // round-trip correctly.
      const ws = new WebSocket(
        `ws://abc.localhost:${ingress.port}/?token=test`,
        "vite-hmr",
      );
      const firstMessage = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error("no HMR message within 10s")),
          HMR_HELLO_TIMEOUT_MS,
        );
        ws.addEventListener("message", (e) => {
          clearTimeout(t);
          resolve(typeof e.data === "string" ? e.data : "");
        });
        ws.addEventListener("close", (e) => {
          clearTimeout(t);
          reject(new Error(`closed before message: ${e.code} ${e.reason}`));
        });
        ws.addEventListener("error", (e) => {
          clearTimeout(t);
          reject(
            new Error(
              `ws error before message: ${(e as ErrorEvent).message ?? "unknown"}`,
            ),
          );
        });
      });
      const parsed = JSON.parse(firstMessage);
      expect(parsed.type).toBe("connected");
      ws.close();
    },
    TEST_TIMEOUT_MS,
  );
});
