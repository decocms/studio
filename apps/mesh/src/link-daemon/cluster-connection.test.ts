import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeFrame,
  encodeFrame,
  type DispatchFrame,
} from "../links/dispatch-frames";
import {
  connectToCluster,
  type ClusterConnectionHandle,
} from "./cluster-connection";

let server: ReturnType<typeof Bun.serve> | null = null;
let handle: ClusterConnectionHandle | null = null;
afterEach(async () => {
  await handle?.close();
  server?.stop(true);
  handle = null;
  server = null;
});

describe("cluster-connection", () => {
  test("sends hello on open and dispatches request frames to handler", async () => {
    const seen: DispatchFrame[] = [];
    let resolveSeen: (() => void) | null = null;
    const seenP = new Promise<void>((r) => {
      resolveSeen = r;
    });

    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          srv.upgrade(req, { data: {} });
          return undefined;
        }
        return new Response("nope", { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.send(
            encodeFrame({
              type: "request",
              reqId: "r-1",
              method: "POST",
              path: "/api/sandboxes",
              headers: {},
              body: JSON.stringify({ handle: "abc" }),
            }),
          );
        },
        message(_ws, raw) {
          const text =
            typeof raw === "string" ? raw : new TextDecoder().decode(raw);
          const frame = decodeFrame(text);
          seen.push(frame);
          if (seen.find((s) => s.type === "end")) resolveSeen?.();
        },
        close() {},
      },
    });

    handle = await connectToCluster({
      url: `ws://127.0.0.1:${server.port}/api/links/connect`,
      accessToken: "tok",
      hello: {
        previewPort: 5174,
        machineId: "m",
        cliVersion: "1",
        capabilities: [],
      },
      controlHandler: {
        async handle(req) {
          expect(req.path).toBe("/api/sandboxes");
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: '{"sandboxApiUrl":"http://127.0.0.1:9000"}',
          };
        },
        handleStream() {
          return (async function* () {})();
        },
      },
    });

    await seenP;
    const types = seen.map((s) => s.type);
    expect(types).toContain("hello");
    expect(types).toContain("headers");
    expect(types).toContain("chunk");
    expect(types).toContain("end");
  });

  test("does not reconnect on close code 4001", async () => {
    let opens = 0;
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          srv.upgrade(req, { data: {} });
          return undefined;
        }
        return new Response("nope", { status: 404 });
      },
      websocket: {
        open(ws) {
          opens++;
          ws.close(4001, "superseded");
        },
        message() {},
        close() {},
      },
    });
    handle = await connectToCluster({
      url: `ws://127.0.0.1:${server.port}/api/links/connect`,
      accessToken: "t",
      hello: {
        previewPort: 5174,
        machineId: "m",
        cliVersion: "1",
        capabilities: [],
      },
      controlHandler: {
        async handle() {
          return { status: 404 };
        },
        handleStream() {
          return (async function* () {})();
        },
      },
      maxAttempts: 5,
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(opens).toBe(1);
  });

  test("reconnects after a successful session closes unexpectedly (regression: #3666)", async () => {
    let opens = 0;
    const closeAfterMs = 50;
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          srv.upgrade(req, { data: {} });
          return undefined;
        }
        return new Response("nope", { status: 404 });
      },
      websocket: {
        open(ws) {
          opens++;
          if (opens === 1) {
            // First open: stay open briefly, then close (simulating a server restart/network blip)
            setTimeout(() => ws.close(1000, "normal closure"), closeAfterMs);
          }
        },
        message() {},
        close() {},
      },
    });
    handle = await connectToCluster({
      url: `ws://127.0.0.1:${server.port}/api/links/connect`,
      accessToken: "t",
      hello: {
        previewPort: 5174,
        machineId: "m",
        cliVersion: "1",
        capabilities: [],
      },
      controlHandler: {
        async handle() {
          return { status: 404 };
        },
        handleStream() {
          return (async function* () {})();
        },
      },
      maxAttempts: 5,
    });

    // Wait for the first connection to open, close, and the backoff delay to elapse.
    // The backoff is ~250-500ms for attempt=1, plus some buffer for socket setup.
    // Before the fix, this would throw "attempt must be >= 1" and crash the reconnect loop.
    await new Promise((r) => setTimeout(r, closeAfterMs + 750));

    // Assert that the daemon attempted at least one reconnect after the close.
    expect(opens).toBeGreaterThanOrEqual(2);
  });

  test("presents a freshly-resolved token on reconnect (stale-token wedge after access-token expiry)", async () => {
    // Reproduces the standalone `deco link` bug: the daemon works, then after
    // some time the WS drops (staging deploy / network blip) and every
    // reconnect re-presents the access token captured at startup. Once that
    // token has expired the cluster rejects the handshake (401 → "Expected 101
    // status code" → 1006 → infinite retry). The daemon must re-resolve the
    // token before each handshake so a refreshed token reaches the reconnect.
    const authHeaders: (string | null)[] = [];
    let resolveSecond: (() => void) | null = null;
    const secondConnected = new Promise<void>((r) => {
      resolveSecond = r;
    });

    // Simulates the access token being refreshed between the first connect and
    // the reconnect. The fix re-reads the token per (re)connect, so the second
    // handshake should carry "refreshed-token".
    const tokens = ["fresh-token", "refreshed-token"];
    const getAccessToken = async () => tokens.shift() ?? "exhausted";

    let opens = 0;
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          authHeaders.push(req.headers.get("authorization"));
          if (authHeaders.length >= 2) resolveSecond?.();
          srv.upgrade(req, { data: {} });
          return undefined;
        }
        return new Response("nope", { status: 404 });
      },
      websocket: {
        open(ws) {
          opens++;
          // Drop the first connection to force a reconnect; the second
          // handshake must carry the refreshed token.
          if (opens === 1)
            setTimeout(() => ws.close(1000, "normal closure"), 30);
        },
        message() {},
        close() {},
      },
    });

    handle = await connectToCluster({
      url: `ws://127.0.0.1:${server.port}/api/links/connect`,
      accessToken: "fresh-token", // legacy static token the buggy path reuses
      getAccessToken,
      hello: {
        previewPort: 5174,
        machineId: "m",
        cliVersion: "1",
        capabilities: [],
      },
      controlHandler: {
        async handle() {
          return { status: 404 };
        },
        handleStream() {
          return (async function* () {})();
        },
      },
      maxAttempts: 5,
    });

    await Promise.race([
      secondConnected,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("no reconnect within 2s")), 2000),
      ),
    ]);

    // Guard: the harness actually captures handshake headers (first connect
    // carries the initial token). If this fails the test is broken, not the bug.
    expect(authHeaders[0]).toBe("Bearer fresh-token");
    // The bug: the reconnect handshake must present the REFRESHED token, not
    // the stale startup token. Fails today (daemon pins `accessToken`), passes
    // once `runOnce` consumes `getAccessToken`.
    expect(authHeaders.length).toBeGreaterThanOrEqual(2);
    expect(authHeaders[1]).toBe("Bearer refreshed-token");
  });

  test("stops reconnecting when the token resolver fails fatally (session unrecoverable)", async () => {
    // When the refresh token itself is dead (re-login required), retrying is
    // pointless — the daemon must stop instead of spinning on a dead credential.
    let calls = 0;
    const getAccessToken = async () => {
      calls++;
      throw Object.assign(
        new Error("session expired — run `deco auth login`"),
        { fatal: true },
      );
    };

    let opens = 0;
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          srv.upgrade(req, { data: {} });
          return undefined;
        }
        return new Response("nope", { status: 404 });
      },
      websocket: {
        open() {
          opens++;
        },
        message() {},
        close() {},
      },
    });

    handle = await connectToCluster({
      url: `ws://127.0.0.1:${server.port}/api/links/connect`,
      accessToken: "unused",
      getAccessToken,
      hello: {
        previewPort: 5174,
        machineId: "m",
        cliVersion: "1",
        capabilities: [],
      },
      controlHandler: {
        async handle() {
          return { status: 404 };
        },
        handleStream() {
          return (async function* () {})();
        },
      },
      maxAttempts: 5,
    });

    // The loop must end (closed resolves) rather than hang/retry forever.
    await Promise.race([
      handle.closed,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("did not stop within 2s")), 2000),
      ),
    ]);

    expect(calls).toBe(1); // no retry after a fatal resolver error
    expect(opens).toBe(0); // never reached the handshake
  });

  test("keeps retrying when the token resolver fails transiently", async () => {
    // A transient refresh failure (network blip while the token is expired)
    // must NOT kill the daemon — it should retry with backoff and recover.
    let calls = 0;
    const getAccessToken = async () => {
      calls++;
      if (calls === 1) throw new Error("refresh network blip"); // transient (no `fatal`)
      return "recovered-token";
    };

    let opens = 0;
    let resolveOpened: (() => void) | null = null;
    const opened = new Promise<void>((r) => {
      resolveOpened = r;
    });
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          srv.upgrade(req, { data: {} });
          return undefined;
        }
        return new Response("nope", { status: 404 });
      },
      websocket: {
        open() {
          opens++;
          resolveOpened?.();
        },
        message() {},
        close() {},
      },
    });

    handle = await connectToCluster({
      url: `ws://127.0.0.1:${server.port}/api/links/connect`,
      accessToken: "unused",
      getAccessToken,
      hello: {
        previewPort: 5174,
        machineId: "m",
        cliVersion: "1",
        capabilities: [],
      },
      controlHandler: {
        async handle() {
          return { status: 404 };
        },
        handleStream() {
          return (async function* () {})();
        },
      },
      maxAttempts: 5,
    });

    await Promise.race([
      opened,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("did not recover within 3s")), 3000),
      ),
    ]);

    expect(calls).toBeGreaterThanOrEqual(2); // retried past the transient failure
    expect(opens).toBeGreaterThanOrEqual(1); // eventually connected
  });
});
