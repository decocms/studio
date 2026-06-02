/**
 * Transparent WebSocket reverse proxy for the daemon.
 *
 * The daemon's HTTP proxy uses fetch(), which doesn't carry WebSocket
 * upgrade semantics. Without this, Vite's HMR client (and any other
 * dev-server WS) gets 502 on the upgrade, retries a few times, then
 * triggers a full-page reload as recovery — the user sees the page load
 * then immediately reload, in a loop.
 *
 * Implementation notes:
 *
 * We CANNOT use Bun's global `WebSocket` or the `ws` npm package as the
 * client to upstream. Bun shims `ws` to its native WebSocket, and Bun's
 * WebSocket client closes its TCP socket with RST instead of FIN. Vite
 * on Node 24 emits an unhandled `error` event on the receiving socket
 * when it sees that RST, which exits the dev-server process.
 *
 * Instead the shared proxy bridge hand-rolls the upstream side by writing the
 * HTTP upgrade over a Node TCP socket. It then implements WebSocket framing
 * inline to bridge bytes between Bun.serve's already-decoded messages and the
 * raw upstream socket. Closing that socket goes through Node's standard FIN
 * path — no RST.
 *
 * Subprotocols (`vite-hmr`, `vite-ping`, …) are forwarded — Vite ignores
 * connections that drop them. The upstream loopback (IPv4 vs IPv6) is
 * picked by a TCP probe before connecting, so a mid-handshake failure
 * never silently retries on the other family.
 */
import {
  createNodeWebSocketProxy,
  createNodeWebSocketProxyData,
  type NodeWebSocketProxyData,
} from "../proxy/websocket";

export type WsProxyData = NodeWebSocketProxyData;

export interface WsUpgraderOptions {
  onClientMessage?: () => void;
}

export function makeWsUpgrader(
  getDevPort: () => number | null,
  opts: WsUpgraderOptions = {},
) {
  const proxy = createNodeWebSocketProxy<WsProxyData>({
    onClientMessage: opts.onClientMessage,
  });

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
      return createNodeWebSocketProxyData({
        port,
        pathQuery: `${url.pathname}${url.search}`,
        protocols,
      });
    },

    open: proxy.open,
    message: proxy.message,
    close: proxy.close,
  };
}

export type WsUpgrader = ReturnType<typeof makeWsUpgrader>;
