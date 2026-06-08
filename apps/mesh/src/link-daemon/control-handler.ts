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
import type { RequestFrame } from "../links/link-control-types";
import type {
  DesktopSandboxProvider,
  RepoRef,
  Workload,
} from "./user-desktop-provider";

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
  workload?: Workload;
  /** Message-offload SSRF allowlist pushed by the cluster (trusted config,
   *  never a request frame). Threaded into the spawned daemon's boot env so
   *  it can fetch offloaded `messagesRef` payloads from these hosts only. */
  offloadAllowedHosts?: string[];
  /** Permit http:// loopback offload refs (dev MinIO). */
  offloadAllowSameHostDev?: boolean;
}

export type StreamEvent =
  | { type: "headers"; status: number; headers: Record<string, string> }
  /**
   * A body chunk carrying the RAW upstream bytes — NOT TextDecoder-decoded
   * (landmine #9). The WS path stringifies these via TextDecoder for its
   * `chunk.data` (UTF-8 text, the WS protocol's historical shape); the pull
   * reverse-proxy channel base64-encodes them so binary vm-tools file reads are
   * byte-exact end-to-end. Keeping the raw bytes here lets each transport pick
   * its own encoding without a lossy UTF-8 round-trip in between.
   */
  | { type: "raw-chunk"; data: Uint8Array };

export interface ControlHandler {
  /** Single-response lifecycle routes (`/api/sandboxes` POST/DELETE). */
  handle(req: RequestFrame): Promise<ControlHandlerResponse>;
  /**
   * Reverse-proxy routes (`/_sandbox/<handle>/<...>`). Yields exactly one
   * `headers` event (carrying the upstream status) followed by zero or more
   * `raw-chunk` events with the raw upstream body bytes. Cluster-connection
   * (WS) and the pull proxy loop each encode those bytes into the matching
   * dispatch/reply frame so the caller sees the real upstream status + body.
   *
   * `signal` (optional) aborts the upstream fetch + read. This is what frees a
   * long-lived `/events` SSE slot on cancel: aborting makes `reader.read()`
   * reject, which runs the `finally` → `acquireDispatch`'s `release()` — the
   * ONLY thing that frees a daemon SSE slot, since `/events` never ends on its
   * own (landmine #3). Without it, a cancel only takes effect at the next
   * upstream byte, which for an idle SSE never arrives.
   */
  handleStream(
    req: RequestFrame,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}

/** Encode a short ASCII status-text body as raw bytes for a `raw-chunk`. */
const textBytes = (s: string): Uint8Array => new TextEncoder().encode(s);

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
        const { sandboxApiUrl, previewUrl } =
          await deps.provider.ensureSandbox(body);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sandboxApiUrl, previewUrl }),
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

    handleStream(req, signal) {
      const sm = SANDBOX_PATH.exec(req.path);
      if (!sm) {
        console.warn(`[control] handleStream no path match path=${req.path}`);
        return (async function* () {
          yield {
            type: "headers" as const,
            status: 404,
            headers: { "content-type": "text/plain" },
          };
          yield { type: "raw-chunk" as const, data: textBytes("not found") };
        })();
      }
      const handle = sm[1] ?? "";
      const rest = sm[2] ?? "/";
      const port = deps.provider.proxyPort(handle);
      if (port == null) {
        // SSE-style endpoints (`/events`, `/idle`) auto-reconnect from the
        // browser, so a handle with no spawned sandbox would flood the log on
        // every retry. Stay quiet for those — same rationale as the verbose
        // gate on the success path below.
        if (rest !== "/events" && rest !== "/idle") {
          console.warn(
            `[control] handleStream unknown handle=${handle} method=${req.method} rest=${rest} (no spawned sandbox for this handle)`,
          );
        }
        return (async function* () {
          yield {
            type: "headers" as const,
            status: 404,
            headers: { "content-type": "text/plain" },
          };
          yield {
            type: "raw-chunk" as const,
            data: textBytes("unknown handle"),
          };
        })();
      }
      const token = deps.provider.getDaemonToken(handle);
      const streamHeaders: Record<string, string> = { ...req.headers };
      if (token) streamHeaders.authorization = `Bearer ${token}`;
      const release = deps.provider.acquireDispatch(handle);
      // SSE-style endpoints (`/events`) are long-lived and noisy; skip the
      // per-request log for them so the link terminal stays focused on the
      // lifecycle + dispatch traffic that actually fails.
      const verbose = rest !== "/events" && rest !== "/idle";
      if (verbose) {
        console.log(
          `[control] proxy ${req.method} ${rest} handle=${handle} port=${port}`,
        );
      }
      return (async function* () {
        try {
          let res: Response;
          try {
            res = await fetcher(`http://127.0.0.1:${port}/_sandbox${rest}`, {
              method: req.method,
              headers: streamHeaders,
              ...(req.body !== undefined ? { body: req.body } : {}),
              redirect: "manual",
              // Aborting cancels the upstream fetch AND a blocked
              // `reader.read()` below, so the `finally` runs `release()` even
              // when an idle `/events` SSE is the thing being cancelled
              // (landmine #3). Omitted when no signal is supplied (e.g. tests).
              ...(signal ? { signal } : {}),
            });
          } catch (err) {
            // Cancel/abort while connecting: quiet, expected (the slot is being
            // freed). Return without an error frame.
            if (signal?.aborted) return;
            // Connection refused / reset: the spawned sandbox daemon died or
            // never bound its port. Surface it — otherwise the cluster only
            // sees a dropped dispatch and reports `decopilot.finish: failed`.
            console.error(
              `[control] proxy ${req.method} ${rest} handle=${handle} port=${port} fetch failed:`,
              err,
            );
            throw err;
          }
          if (verbose && (res.status < 200 || res.status >= 300)) {
            console.warn(
              `[control] proxy ${req.method} ${rest} → ${res.status} handle=${handle}`,
            );
          }
          yield {
            type: "headers" as const,
            status: res.status,
            headers: Object.fromEntries(res.headers),
          };
          if (!res.body) return;
          const reader = res.body.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value && value.length) {
                // Yield the RAW bytes — no TextDecoder (landmine #9). The
                // transport (WS / pull proxy) chooses its own encoding so a
                // binary vm-tools file read survives byte-exact.
                yield { type: "raw-chunk" as const, data: value };
              }
            }
          } catch (err) {
            // Cancel/abort mid-stream (e.g. an `/events` SSE being cancelled to
            // free the slot): quiet, expected. The `finally` still runs
            // `release()` (below), which is the whole point.
            if (signal?.aborted) return;
            // Connect succeeded but the upstream body stream broke mid-flight
            // (e.g. the spawned daemon crashed its SSE writer). Distinct from
            // the connect-failure log above; this re-throw surfaces as a
            // `handler_error` frame sent back via the pull reply channel.
            console.error(
              `[control] proxy ${req.method} ${rest} handle=${handle} port=${port} body stream error: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            throw err;
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
