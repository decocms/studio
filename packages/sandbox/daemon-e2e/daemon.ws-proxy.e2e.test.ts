/**
 * Daemon conformance suite — WEBSOCKET REVERSE PROXY.
 *
 * `daemon.proxy.e2e.test.ts` covers the HTTP reverse-proxy branch; this file
 * covers the WebSocket-upgrade branch (`ws-proxy.ts` / `proxy/websocket.ts`).
 * A stub upstream WS server is just another `Bun.serve` with a `websocket`
 * handler — Bun speaks the server side of the WS handshake natively, so no
 * hand-rolled HTTP-upgrade parsing is needed on the test side (the daemon's
 * OWN upstream leg hand-rolls it — see ws-proxy.ts's file header for why —
 * but that's implementation the test drives black-box, not something the
 * test needs to replicate).
 *
 * The client-facing side is a real WebSocket connecting through the DAEMON's
 * listener, exactly like a browser or Vite's HMR client would. No daemon
 * source is imported — every assertion is over the wire.
 */
import { afterEach, describe, expect, it } from "bun:test";

import {
  type Daemon,
  freePort,
  HOOK_TIMEOUT_MS,
  postConfig,
  startDaemon,
  stopDaemon,
} from "./daemon.e2e.helpers";

const WS_TIMEOUT_MS = 10_000;

let d: Daemon | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let client: WebSocket | null = null;

afterEach(async () => {
  try {
    client?.close();
  } catch {
    /* already closed */
  }
  client = null;
  await stopDaemon(d);
  d = null;
  if (upstream) {
    upstream.stop(true);
    upstream = null;
  }
}, HOOK_TIMEOUT_MS);

/** Point the daemon's dev port at `port` (no listener required). */
async function setDevPort(daemon: Daemon, port: number): Promise<void> {
  const res = await postConfig(daemon, { application: { port } });
  expect(res.status).toBe(200);
}

/** `ws://` form of a daemon path — `url()` from helpers builds `http://`. */
function wsUrl(daemon: Daemon, path: string): string {
  return `ws://localhost:${daemon.port}${path}`;
}

/** Resolve once `event` fires on `ws`, or reject after `timeoutMs`. */
function onceEvent<T>(
  ws: WebSocket,
  event: "open" | "message" | "close",
  extract: (e: never) => T,
  timeoutMs = WS_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ws '${event}'`)),
      timeoutMs,
    );
    ws.addEventListener(
      event,
      (e) => {
        clearTimeout(timer);
        resolve(extract(e as never));
      },
      { once: true },
    );
  });
}

describe("daemon e2e: WebSocket reverse proxy", () => {
  it(
    "successful upgrade + echo round-trip; forwards the client's subprotocol upstream",
    async () => {
      let capturedProtocol: string | null = null;
      upstream = Bun.serve({
        port: 0,
        fetch(req, server) {
          capturedProtocol = req.headers.get("sec-websocket-protocol");
          if (server.upgrade(req)) return;
          return new Response("upgrade failed", { status: 400 });
        },
        websocket: {
          message(ws, message) {
            ws.send(message);
          },
        },
      });
      d = await startDaemon();
      await setDevPort(d, upstream.port as number);

      client = new WebSocket(wsUrl(d, "/hmr?x=1"), ["vite-hmr"]);
      await onceEvent(client, "open", () => undefined);
      client.send("ping");
      const echoed = await onceEvent(client, "message", (e) => String(e.data));
      expect(echoed).toBe("ping");
      // The subprotocol travels through the daemon's hand-rolled upstream
      // upgrade — asserted on the stub server's incoming request, since the
      // daemon negotiates the client-facing protocol independently at
      // `server.upgrade()` (see ws-proxy.ts).
      expect(capturedProtocol).toBe("vite-hmr");
    },
    WS_TIMEOUT_MS,
  );

  it(
    "server-initiated close propagates to the client with the same code + reason",
    async () => {
      upstream = Bun.serve({
        port: 0,
        fetch(req, server) {
          if (server.upgrade(req)) return;
          return new Response("upgrade failed", { status: 400 });
        },
        websocket: {
          open(ws) {
            ws.close(4009, "server done");
          },
          message() {},
        },
      });
      d = await startDaemon();
      await setDevPort(d, upstream.port as number);

      client = new WebSocket(wsUrl(d, "/"));
      const closed = await onceEvent(client, "close", (e) => ({
        code: e.code,
        reason: e.reason,
      }));
      expect(closed.code).toBe(4009);
      expect(closed.reason).toBe("server done");
    },
    WS_TIMEOUT_MS,
  );

  it(
    "dead upstream port: closes the client with 1011 'upstream not reachable'",
    async () => {
      d = await startDaemon();
      const deadPort = await freePort(); // nothing listening there
      await setDevPort(d, deadPort);

      client = new WebSocket(wsUrl(d, "/anything"));
      const closed = await onceEvent(client, "close", (e) => ({
        code: e.code,
        reason: e.reason,
      }));
      expect(closed.code).toBe(1011);
      expect(closed.reason).toBe("upstream not reachable");
    },
    WS_TIMEOUT_MS,
  );

  it(
    "no dev port configured at all: closes the client with 1011 'no upstream dev server'",
    async () => {
      d = await startDaemon();
      // No POST /config at all — getDevPort() is null from boot.

      client = new WebSocket(wsUrl(d, "/"));
      const closed = await onceEvent(client, "close", (e) => ({
        code: e.code,
        reason: e.reason,
      }));
      expect(closed.code).toBe(1011);
      expect(closed.reason).toBe("no upstream dev server");
    },
    WS_TIMEOUT_MS,
  );

  it(
    "client-initiated close is forwarded upstream (upstream observes a clean close)",
    async () => {
      let resolveUpstreamClose: () => void;
      const upstreamClosed = new Promise<void>((resolve) => {
        resolveUpstreamClose = resolve;
      });
      upstream = Bun.serve({
        port: 0,
        fetch(req, server) {
          if (server.upgrade(req)) return;
          return new Response("upgrade failed", { status: 400 });
        },
        websocket: {
          message(ws, message) {
            ws.send(message);
          },
          close() {
            resolveUpstreamClose();
          },
        },
      });
      d = await startDaemon();
      await setDevPort(d, upstream.port as number);

      client = new WebSocket(wsUrl(d, "/"));
      await onceEvent(client, "open", () => undefined);
      // The client-facing socket opens independently of the daemon's async
      // connect-to-upstream leg (see ws-proxy.ts's `open`) — round-trip a
      // message first so the daemon's `ws.data.upstream` is definitely wired
      // before we close, otherwise `close()` has nothing to forward to.
      client.send("ready?");
      await onceEvent(client, "message", (e) => String(e.data));
      client.close(1000, "bye");
      await Promise.race([
        upstreamClosed,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("upstream never observed the close")),
            WS_TIMEOUT_MS - 500,
          ),
        ),
      ]);
    },
    WS_TIMEOUT_MS,
  );
});
