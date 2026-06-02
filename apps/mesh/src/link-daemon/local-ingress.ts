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
  upstream?: WebSocket;
  pendingMessages: Array<string | Uint8Array>;
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
        const ok = srv.upgrade(req, {
          data: {
            sandboxPort,
            upstreamPath: `${reqUrl.pathname}${reqUrl.search}`,
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
        const { sandboxPort, upstreamPath } = ws.data;
        const upstream = new WebSocket(
          `ws://127.0.0.1:${sandboxPort}${upstreamPath}`,
        );
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
            ws.send(e.data as string);
          } catch {
            /* */
          }
        });
        upstream.addEventListener("close", () => {
          try {
            ws.close();
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
        const msg = typeof raw === "string" ? raw : new Uint8Array(raw);
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
