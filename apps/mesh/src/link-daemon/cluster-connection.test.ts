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
});
