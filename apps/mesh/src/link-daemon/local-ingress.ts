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
    async fetch(req, srv) {
      const host = req.headers.get("host");
      const handle = parseHandleFromHost(host);
      if (!handle) return new Response("not found", { status: 404 });
      const sandboxPort = input.lookupSandboxPort(handle);
      if (!sandboxPort) return new Response("unknown handle", { status: 404 });

      if (req.headers.get("upgrade") === "websocket") {
        const reqUrl = new URL(req.url);
        const protocolHeader = req.headers.get("sec-websocket-protocol");
        const upstreamProtocols = protocolHeader
          ? protocolHeader
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        const ok = srv.upgrade(req, {
          data: createNodeWebSocketProxyData({
            port: sandboxPort,
            pathQuery: `${reqUrl.pathname}${reqUrl.search}`,
            protocols:
              upstreamProtocols.length > 0 ? upstreamProtocols : undefined,
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
