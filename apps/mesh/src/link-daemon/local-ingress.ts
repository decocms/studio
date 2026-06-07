/**
 * Local ingress on the user's machine. Single Bun.serve on a configurable
 * port. Routes by Host header: `<handle>.localhost[:port]` → the sandbox's
 * local HTTP port. HTTP and WebSocket upgrades are both proxied.
 *
 * No auth — same posture as `bun dev`; the listener is 127.0.0.1-only.
 */
import {
  createNodeWebSocketProxy,
  createNodeWebSocketProxyData,
  parseWebSocketProtocols,
  type NodeWebSocketProxyData,
} from "@decocms/sandbox/proxy/websocket";
import { parseHandleFromHost } from "./host-parser";

/**
 * Cap on frames buffered between client upgrade and upstream WS open. Vite
 * HMR sends roughly one frame per file event, so 256 covers a normal cold
 * start with room to spare while preventing a slow/blackholed upstream from
 * exhausting daemon memory. Mirrors MAX_PENDING_FRAMES in preview-proxy.ts.
 */
const MAX_PENDING_FRAMES = 256;

/**
 * Served for a valid `<handle>.localhost` whose sandbox isn't spawned yet
 * (e.g. right after `deco link` relinks, before the cluster respawns it).
 * Auto-reloads so the iframe flips to the live dev server as soon as the
 * sandbox is up — no frontend state needed.
 */
const CONNECTING_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connecting…</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa;color:#555}div{text-align:center;max-width:420px;padding:24px}h3{margin:0 0 8px}p{margin:0;font-size:14px;color:#999;line-height:1.5}</style></head><body><div><h3>Connecting to sandbox…</h3><p>Waiting for the local sandbox to come online. This page refreshes automatically.</p></div><script>setTimeout(function(){window.location.reload()},1500)</script></body></html>`;

export interface StartLocalIngressInput {
  port: number;
  lookupSandboxPort: (handle: string) => number | null;
  maxPendingWsFrames?: number;
}

export interface LocalIngress {
  port: number;
  stop(): Promise<void>;
}

type WsData = NodeWebSocketProxyData;

export async function startLocalIngress(
  input: StartLocalIngressInput,
): Promise<LocalIngress> {
  const wsProxy = createNodeWebSocketProxy<WsData>({
    maxPendingFrames: input.maxPendingWsFrames ?? MAX_PENDING_FRAMES,
    backlogOverflowReason: "ingress backlog overflow",
  });

  const server = Bun.serve<WsData>({
    port: input.port,
    hostname: "127.0.0.1",
    // Disable Bun's default 10s idle timeout: the ingress proxies long-lived
    // requests to the sandbox dev server (SSE/streaming chat previews, Vite
    // HMR, cold-starting servers) that legitimately produce no I/O for >10s.
    // Without this, Bun aborts those connections at 10s and logs
    //   "[Bun.serve]: request timed out after 10 seconds."
    // dropping the preview mid-stream. Mirrors apps/mesh/src/index.ts and the
    // sandbox daemon (packages/sandbox/daemon/entry.ts), which set this for the
    // same SSE reason.
    idleTimeout: 0,
    async fetch(req, srv) {
      const host = req.headers.get("host");
      const handle = parseHandleFromHost(host);
      if (!handle) return new Response("not found", { status: 404 });
      const sandboxPort = input.lookupSandboxPort(handle);
      if (!sandboxPort) {
        // WebSocket upgrades can't render HTML — fail them so the client retries.
        if (req.headers.get("upgrade") === "websocket") {
          return new Response("unknown handle", { status: 404 });
        }
        return new Response(CONNECTING_HTML, {
          status: 503,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Retry-After": "1",
          },
        });
      }

      if (req.headers.get("upgrade") === "websocket") {
        const reqUrl = new URL(req.url);
        const ok = srv.upgrade(req, {
          data: createNodeWebSocketProxyData({
            port: sandboxPort,
            pathQuery: `${reqUrl.pathname}${reqUrl.search}`,
            protocols: parseWebSocketProtocols(req.headers),
          }),
        });
        if (!ok) return new Response("ws upgrade failed", { status: 400 });
        return undefined as unknown as Response;
      }

      const url = new URL(req.url);
      const target = `http://127.0.0.1:${sandboxPort}${url.pathname}${url.search}`;
      const headers = new Headers(req.headers);
      headers.set("host", `127.0.0.1:${sandboxPort}`);
      return fetch(target, {
        method: req.method,
        headers,
        body: req.body,
        redirect: "manual",
      });
    },
    websocket: {
      open: wsProxy.open,
      message: wsProxy.message,
      close: wsProxy.close,
    },
  });

  return {
    port: server.port ?? 0,
    async stop() {
      server.stop(true);
    },
  };
}
