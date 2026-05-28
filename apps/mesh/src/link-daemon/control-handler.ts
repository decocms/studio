/**
 * In-process control handler for the daemon. Replaces the previous HTTP+HMAC
 * `control-plane.ts`. The cluster-connection demuxer (task 12) calls
 * `handle(requestFrame)` for one-shot lifecycle routes, and
 * `handleStream(requestFrame)` for every `/_sandbox/<handle>/*` reverse-proxy
 * path (those paths can be streaming or one-shot; either way the streaming
 * surface yields real upstream status + headers).
 *
 * Routes:
 *   POST   /api/sandboxes                 → ensureSandbox (in-process)
 *   DELETE /api/sandboxes/<handle>        → deleteSandbox (in-process)
 *   *      /_sandbox/<handle>/<rest>      → reverse-proxy to the spawned
 *                                            sandbox daemon's local port
 */
import type { RequestFrame } from "../links/dispatch-frames";
import type { DesktopSandboxProvider, RepoRef } from "./user-desktop-provider";

export interface ControlHandlerResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface ControlHandlerDeps {
  provider: DesktopSandboxProvider;
  /** Default `fetch`; tests inject. */
  fetchImpl?: typeof fetch;
}

interface EnsureSandboxBody {
  handle: string;
  repo?: RepoRef;
}

export type StreamEvent =
  | { type: "headers"; status: number; headers: Record<string, string> }
  | { type: "raw-chunk"; data: string };

export interface ControlHandler {
  /** Single-response lifecycle routes (`/api/sandboxes` POST/DELETE). */
  handle(req: RequestFrame): Promise<ControlHandlerResponse>;
  /**
   * Reverse-proxy routes (`/_sandbox/<handle>/<...>`). Yields exactly one
   * `headers` event (carrying the upstream status) followed by zero or more
   * `raw-chunk` events with body text. Cluster-connection encodes each as
   * the matching dispatch frame so the caller sees the real upstream status.
   */
  handleStream(req: RequestFrame): AsyncIterable<StreamEvent>;
}

const SANDBOX_PATH = /^\/_sandbox\/([^/]+)(\/.*)?$/;

export function createControlHandler(deps: ControlHandlerDeps): ControlHandler {
  const fetcher = deps.fetchImpl ?? fetch;

  return {
    async handle(req) {
      if (req.path === "/api/sandboxes" && req.method === "POST") {
        let body: EnsureSandboxBody;
        try {
          body = JSON.parse(req.body ?? "") as EnsureSandboxBody;
        } catch {
          return {
            status: 400,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: "invalid_json" }),
          };
        }
        if (typeof body.handle !== "string" || body.handle.length === 0) {
          return {
            status: 400,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: "missing_handle" }),
          };
        }
        const { sandboxApiUrl } = await deps.provider.ensureSandbox(body);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sandboxApiUrl }),
        };
      }
      if (req.path.startsWith("/api/sandboxes/") && req.method === "DELETE") {
        const handle = req.path.slice("/api/sandboxes/".length);
        if (!handle) {
          return {
            status: 400,
            body: JSON.stringify({ error: "missing_handle" }),
            headers: { "content-type": "application/json" },
          };
        }
        await deps.provider.deleteSandbox(handle);
        return { status: 204 };
      }

      // Per-handle liveness probe used by the cluster's `provider.alive`.
      // Returns 200 if the daemon either has a ready entry for `handle` or
      // is currently spawning one. Must NOT 404 on in-flight handles —
      // vm-events translates 404 into `event: gone` + state-store cleanup,
      // which would tear down the sandbox the user is mid-start.
      if (req.path.startsWith("/api/sandboxes/") && req.method === "GET") {
        const handle = req.path.slice("/api/sandboxes/".length);
        if (!handle) {
          return {
            status: 400,
            body: JSON.stringify({ error: "missing_handle" }),
            headers: { "content-type": "application/json" },
          };
        }
        const known = deps.provider.hasHandle(handle);
        return known
          ? {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ handle }),
            }
          : { status: 404 };
      }

      return { status: 404, body: "not found" };
    },

    handleStream(req) {
      const sm = SANDBOX_PATH.exec(req.path);
      if (!sm) {
        return (async function* () {
          yield {
            type: "headers" as const,
            status: 404,
            headers: { "content-type": "text/plain" },
          };
          yield { type: "raw-chunk" as const, data: "not found" };
        })();
      }
      const handle = sm[1] ?? "";
      const rest = sm[2] ?? "/";
      const port = deps.provider.proxyPort(handle);
      if (port == null) {
        return (async function* () {
          yield {
            type: "headers" as const,
            status: 404,
            headers: { "content-type": "text/plain" },
          };
          yield { type: "raw-chunk" as const, data: "unknown handle" };
        })();
      }
      const token = deps.provider.getDaemonToken(handle);
      const streamHeaders: Record<string, string> = { ...req.headers };
      if (token) streamHeaders.authorization = `Bearer ${token}`;
      const release = deps.provider.acquireDispatch(handle);
      return (async function* () {
        try {
          const res = await fetcher(
            `http://127.0.0.1:${port}/_sandbox${rest}`,
            {
              method: req.method,
              headers: streamHeaders,
              ...(req.body !== undefined ? { body: req.body } : {}),
              redirect: "manual",
            },
          );
          yield {
            type: "headers" as const,
            status: res.status,
            headers: Object.fromEntries(res.headers),
          };
          if (!res.body) return;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) {
                // Flush any pending multi-byte sequence held by the decoder.
                const tail = decoder.decode();
                if (tail.length > 0) {
                  yield { type: "raw-chunk" as const, data: tail };
                }
                break;
              }
              if (value && value.length) {
                yield {
                  type: "raw-chunk" as const,
                  data: decoder.decode(value, { stream: true }),
                };
              }
            }
          } finally {
            reader.releaseLock();
          }
        } finally {
          release();
        }
      })();
    },
  };
}
