/**
 * In-process control handler for the daemon. Replaces the previous HTTP+HMAC
 * `control-plane.ts`. The cluster-connection demuxer (task 12) calls
 * `handle(requestFrame)` for one-shot routes, and `handleStream(requestFrame)`
 * for `/_sandbox/<handle>/*` paths whose responses stream.
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

export interface ControlHandler {
  /** Single-response routes (sandbox lifecycle + non-streaming proxies). */
  handle(req: RequestFrame): Promise<ControlHandlerResponse>;
  /**
   * Streaming routes (`/_sandbox/<handle>/<...>`). Yields `{type, data}`
   * objects, where `data` is a raw body chunk text. The cluster-connection
   * encodes each as a `chunk` frame.
   */
  handleStream(
    req: RequestFrame,
  ): AsyncIterable<{ type: "raw-chunk"; data: string }>;
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

      // Non-streaming reverse-proxy: `/_sandbox/<handle>/<...>` paths whose
      // upstream returns a single body. Streaming paths use handleStream.
      const sm = SANDBOX_PATH.exec(req.path);
      if (sm) {
        const handle = sm[1] ?? "";
        const rest = sm[2] ?? "/";
        const port = deps.provider.proxyPort(handle);
        if (port == null) return { status: 404, body: "unknown handle" };
        const res = await fetcher(`http://127.0.0.1:${port}/_sandbox${rest}`, {
          method: req.method,
          headers: req.headers,
          ...(req.body !== undefined ? { body: req.body } : {}),
          redirect: "manual",
        });
        const text = await res.text();
        return {
          status: res.status,
          headers: Object.fromEntries(res.headers),
          body: text,
        };
      }
      return { status: 404, body: "not found" };
    },

    handleStream(req) {
      const sm = SANDBOX_PATH.exec(req.path);
      if (!sm) {
        return (async function* () {})();
      }
      const handle = sm[1] ?? "";
      const rest = sm[2] ?? "/";
      const port = deps.provider.proxyPort(handle);
      if (port == null) return (async function* () {})();
      const release = deps.provider.acquireDispatch(handle);
      return (async function* () {
        try {
          const res = await fetcher(
            `http://127.0.0.1:${port}/_sandbox${rest}`,
            {
              method: req.method,
              headers: req.headers,
              ...(req.body !== undefined ? { body: req.body } : {}),
            },
          );
          if (!res.body) return;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value && value.length) {
                yield {
                  type: "raw-chunk" as const,
                  data: decoder.decode(value),
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
