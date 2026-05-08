/**
 * Transparent WebSocket reverse proxy for the daemon.
 *
 * The daemon's HTTP proxy uses fetch(), which doesn't carry WebSocket
 * upgrade semantics. Without this, Vite's HMR client (and any other
 * dev-server WS) gets 502 on the upgrade, retries a few times, then
 * triggers a full-page reload as recovery — the user sees the page load
 * then immediately reload, in a loop.
 *
 * On upgrade we stash the upstream port, path/query, and the client's
 * negotiated subprotocols in ws.data, then open the upstream WS on the
 * `open` callback and bridge frames in both directions. Subprotocols
 * (`vite-hmr`, `vite-ping`, …) are forwarded — Vite ignores connections
 * that drop them. The upstream loopback (IPv4 vs IPv6) is picked by a
 * TCP probe before connecting, so a mid-handshake failure never silently
 * retries on the other family.
 */
import type { ServerWebSocket } from "bun";
import { bracketHost, pickLoopback } from "./loopback";

/**
 * Cap on frames buffered between client upgrade and upstream WS open. The
 * upstream here is the in-pod dev server on localhost; if it isn't yet
 * listening (booting / crashed), an unbounded pending queue would let a
 * chatty client exhaust the daemon's memory.
 */
const MAX_PENDING_FRAMES = 256;

export interface WsProxyData {
  /** Upstream dev-server port. Null when no port is known at upgrade time. */
  port: number | null;
  /** Path + query of the upgrade request, forwarded verbatim. */
  pathQuery: string;
  /** Subprotocols the client advertised on the upgrade request. */
  protocols: string[] | undefined;
  upstream: WebSocket | null;
  /** Frames received from the client before the upstream handshake completes. */
  pending: (string | ArrayBuffer | Uint8Array)[];
}

export interface WsUpgraderOptions {
  onClientMessage?: () => void;
}

export function makeWsUpgrader(
  getDevPort: () => number | null,
  opts: WsUpgraderOptions = {},
) {
  return {
    /** Build the per-connection state attached to ws.data at upgrade time.
     *  Falls back to `port=null` when no upstream port is known; `open()`
     *  closes the client immediately rather than connecting to a guess. */
    upgradeData(req: Request): WsProxyData {
      const url = new URL(req.url);
      const port = getDevPort();
      const protoHeader = req.headers.get("sec-websocket-protocol");
      const protocols = protoHeader
        ? protoHeader
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      return {
        port,
        pathQuery: `${url.pathname}${url.search}`,
        protocols,
        upstream: null,
        pending: [],
      };
    },

    open(ws: ServerWebSocket<WsProxyData>): void {
      if (ws.data.port === null) {
        try {
          ws.close(1011, "no upstream dev server");
        } catch {}
        return;
      }
      void connectUpstream(ws);
    },

    message(ws: ServerWebSocket<WsProxyData>, message: string | Buffer): void {
      opts.onClientMessage?.();
      const upstream = ws.data.upstream;
      const frame = typeof message === "string" ? message : message.buffer;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        try {
          upstream.send(frame as never);
        } catch {}
        return;
      }
      if (ws.data.pending.length >= MAX_PENDING_FRAMES) {
        // Backlog overflow: upstream isn't draining. 1011 = internal error.
        try {
          ws.close(1011, "ws-proxy backlog overflow");
        } catch {}
        try {
          ws.data.upstream?.close();
        } catch {}
        return;
      }
      ws.data.pending.push(frame as ArrayBuffer | string);
    },

    close(ws: ServerWebSocket<WsProxyData>): void {
      try {
        ws.data.upstream?.close();
      } catch {}
    },
  };
}

export type WsUpgrader = ReturnType<typeof makeWsUpgrader>;

async function connectUpstream(
  ws: ServerWebSocket<WsProxyData>,
): Promise<void> {
  const port = ws.data.port;
  if (port === null) return;
  const host = await pickLoopback(port);
  if (host === null) {
    try {
      ws.close(1011, "upstream not reachable");
    } catch {}
    return;
  }
  const target = `ws://${bracketHost(host)}:${port}${ws.data.pathQuery}`;
  const upstream = new WebSocket(target, ws.data.protocols);
  upstream.binaryType = "arraybuffer";
  ws.data.upstream = upstream;

  upstream.addEventListener("open", () => {
    for (const frame of ws.data.pending) {
      try {
        upstream.send(frame as never);
      } catch {}
    }
    ws.data.pending.length = 0;
  });
  upstream.addEventListener("message", (e) => {
    try {
      ws.send(e.data as never);
    } catch {}
  });
  upstream.addEventListener("close", () => {
    try {
      ws.close();
    } catch {}
  });
  upstream.addEventListener("error", () => {
    try {
      ws.close();
    } catch {}
  });
}
