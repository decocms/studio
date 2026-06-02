/**
 * Local ingress on the user's machine. Single Bun.serve on a configurable
 * port. Routes by Host header: `<handle>.localhost[:port]` → the sandbox's
 * local HTTP port. HTTP and WebSocket upgrades are both proxied.
 *
 * No auth — same posture as `bun dev`; the listener is 127.0.0.1-only.
 */
import { parseHandleFromHost } from "./host-parser";

export interface StartLocalIngressInput {
  port: number;
  lookupSandboxPort: (handle: string) => number | null;
}

export interface LocalIngress {
  port: number;
  stop(): Promise<void>;
}

interface WsData {
  sandboxPort: number;
  /** Path + query the client requested; forwarded verbatim to upstream. */
  upstreamPath: string;
  /** Subprotocols requested by the client; passed to the upstream WS ctor. */
  upstreamProtocols: string[];
  upstream?: WebSocket;
  pendingMessages: Array<string | Uint8Array | ArrayBuffer>;
}

export async function startLocalIngress(
  input: StartLocalIngressInput,
): Promise<LocalIngress> {
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
          data: {
            sandboxPort,
            upstreamPath: `${reqUrl.pathname}${reqUrl.search}`,
            upstreamProtocols,
            pendingMessages: [],
          },
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
      async open(ws) {
        const { sandboxPort, upstreamPath, upstreamProtocols } = ws.data;
        const upstream =
          upstreamProtocols.length > 0
            ? new WebSocket(
                `ws://127.0.0.1:${sandboxPort}${upstreamPath}`,
                upstreamProtocols,
              )
            : new WebSocket(`ws://127.0.0.1:${sandboxPort}${upstreamPath}`);
        upstream.binaryType = "arraybuffer";
        ws.data.upstream = upstream;
        ws.data.pendingMessages = [];
        upstream.addEventListener("open", () => {
          // Flush any messages that arrived before upstream was ready.
          const pending = ws.data.pendingMessages;
          ws.data.pendingMessages = [];
          for (const msg of pending) {
            try {
              upstream.send(msg);
            } catch {
              /* */
            }
          }
        });
        upstream.addEventListener("message", (e) => {
          try {
            ws.send(e.data as string | Uint8Array | ArrayBuffer);
          } catch {
            /* */
          }
        });
        upstream.addEventListener("close", (ev: CloseEvent) => {
          try {
            ws.close(ev.code || 1000, ev.reason || "");
          } catch {
            /* */
          }
        });
        // Without this, a failed upstream connect (sandbox died, port not yet
        // bound) emits `error` and may never emit `close` — the client WS
        // stays open with `pendingMessages` accumulating indefinitely.
        upstream.addEventListener("error", () => {
          try {
            ws.close(1011, "upstream error");
          } catch {
            /* */
          }
        });
      },
      message(ws, raw) {
        const upstream = ws.data.upstream;
        const msg: string | Uint8Array | ArrayBuffer =
          typeof raw === "string"
            ? raw
            : raw instanceof ArrayBuffer
              ? raw
              : new Uint8Array(raw);
        if (!upstream || upstream.readyState !== WebSocket.OPEN) {
          ws.data.pendingMessages.push(msg);
          return;
        }
        try {
          upstream.send(msg);
        } catch {
          /* */
        }
      },
      close(ws) {
        const upstream = ws.data.upstream;
        try {
          upstream?.close();
        } catch {
          /* */
        }
      },
    },
  });

  return {
    port: server.port ?? 0,
    async stop() {
      server.stop(true);
    },
  };
}
