/**
 * Sandbox preview reverse-proxy.
 *
 * Inbound requests to `<handle>.preview.<base-domain>` are routed to the
 * matching sandbox's daemon at port 9000. Mesh stays in the request path
 * for the first ship; long-term plan is per-claim HTTPRoute objects (see
 * the K8s sandbox plan), but this keeps DNS + RBAC simple while we ship.
 *
 * Why preview must terminate on port 9000 and never on the in-pod dev port
 * (3000): the daemon's reverse proxy strips CSP/X-Frame headers and injects
 * the HMR bootstrap that vite needs to function inside the studio iframe.
 * Routing browsers straight at the dev port breaks SSE + iframe embedding.
 *
 * Auth model: preview URLs are open-by-handle, the same way Vercel preview
 * URLs are. The handle is the secret. /_decopilot_vm/* is rejected here
 * (defense-in-depth — the daemon's bearer-token check rejects it too) so
 * the admin surface stays uncallable from preview hosts.
 */

import type { AgentSandboxRunner } from "@decocms/sandbox/runner/agent-sandbox";

/**
 * Cap on frames buffered between client upgrade and upstream WS open. Vite
 * HMR sends ~1 frame per file event, so 256 covers a normal cold start with
 * room to spare while preventing a slow/blackholed upstream from exhausting
 * mesh memory.
 */
const MAX_PENDING_FRAMES = 256;

/**
 * Parses the base preview hostname (e.g. `preview.decocms.com`) out of the
 * `STUDIO_SANDBOX_PREVIEW_URL_PATTERN` value. The pattern has the form
 * `https://{handle}.preview.example.com` (or `https://{handle}.<base>`),
 * matching what the K8s runner's `applyPreviewPattern` produces. Returns
 * null when the pattern is empty/missing/malformed — preview proxying is
 * disabled in that case.
 */
export function parsePreviewBaseDomain(
  pattern: string | null | undefined,
): string | null {
  if (!pattern || pattern.trim() === "") return null;
  // Substituting a placeholder before parsing handles the `{handle}` form.
  // For the non-templated form we still get a valid URL whose hostname is
  // the base.
  const probe = pattern.includes("{handle}")
    ? pattern.replace("{handle}", "__handle__")
    : pattern;
  let url: URL;
  try {
    url = new URL(probe);
  } catch {
    return null;
  }
  // `__handle__.preview.example.com` → strip the leading subdomain to get the
  // base. If there's no leading subdomain segment, the pattern was bad.
  const host = url.hostname;
  if (pattern.includes("{handle}")) {
    const dot = host.indexOf(".");
    if (dot <= 0 || dot === host.length - 1) return null;
    return host.slice(dot + 1);
  }
  // Bare-pattern form (no `{handle}`): `https://preview.example.com` — the
  // hostname *is* the base. The runner's applyPreviewPattern in this case
  // emits `https://<handle>.preview.example.com`.
  return host;
}

/**
 * Pulls the sandbox handle out of a request Host header. Returns null when
 * the host doesn't match `<handle>.<baseDomain>` (meaning the request isn't
 * for a mesh sandbox preview and should fall through to the rest of the
 * mesh API).
 */
export function extractHandleFromHost(
  host: string | null | undefined,
  baseDomain: string,
): string | null {
  if (!host || !baseDomain) return null;
  const colon = host.indexOf(":");
  const cleanHost = (colon >= 0 ? host.slice(0, colon) : host).toLowerCase();
  const cleanBase = baseDomain.toLowerCase().replace(/^\.+|\.+$/g, "");
  const suffix = `.${cleanBase}`;
  if (!cleanHost.endsWith(suffix)) return null;
  const handle = cleanHost.slice(0, cleanHost.length - suffix.length);
  // Reject empty / nested subdomains: `foo.bar.preview.example.com` would be
  // `foo.bar`, which is not a valid handle.
  if (!handle || handle.includes(".")) return null;
  return handle;
}

export interface PreviewProxyDeps {
  /**
   * Lazy runner accessor. Returns null when the mesh isn't configured for
   * the agent-sandbox runner — the caller treats null as "not a preview
   * deployment" and falls through.
   */
  getRunner: () => Promise<AgentSandboxRunner | null>;
  baseDomain: string;
}

/**
 * Returns a Response if the request was a preview request (handled here),
 * otherwise null (caller should fall through to its normal routing).
 *
 * 503 is returned when the runner isn't ready yet — preview traffic hit the
 * mesh before any sandbox tool initialized the runner. The browser will
 * retry; by then the runner should be up.
 */
export async function tryHandlePreviewHttp(
  request: Request,
  deps: PreviewProxyDeps,
): Promise<Response | null> {
  const handle = extractHandleFromHost(
    request.headers.get("host"),
    deps.baseDomain,
  );
  if (!handle) return null;

  const runner = await deps.getRunner();
  if (!runner) {
    return errorResponse(503, "preview proxy not configured");
  }
  return runner.proxyPreviewRequest(handle, request);
}

// Cross-origin error envelope. Studio runs under its own origin and reads
// these via fetch (EventSource probeMissing, SSE error frames); without ACAO
// the browser hides the status and devtools surfaces an opaque CORS failure.
function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

/**
 * WebSocket upgrade payload — Bun's `server.upgrade()` stashes this under
 * `ws.data` for the websocket handler to use. Keeping the upstream URL +
 * subprotocols here means the handler doesn't need to re-parse the host.
 */
export interface PreviewWsData {
  kind: "preview";
  upstreamUrl: string;
  upstreamProtocols: string[];
  /** Buffer messages received before the upstream WS finishes opening. */
  pending: Array<string | Uint8Array | ArrayBuffer>;
  upstream: WebSocket | null;
  closed: boolean;
}

export function isPreviewWsData(data: unknown): data is PreviewWsData {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "preview"
  );
}

/**
 * Bun-specific upgrade interceptor: consumed by the top-level Bun.serve
 * fetch handler. Returns:
 *   - undefined when the request was upgraded (Bun.serve treats this as
 *     "the response will come from the WS handler later")
 *   - a Response when the request matched preview but couldn't be upgraded
 *     (404/502/503), letting the caller return it directly
 *   - null when the request isn't a preview WS request (caller falls through)
 *
 * Only handles `Upgrade: websocket` requests. Plain HTTP/SSE goes through
 * `tryHandlePreviewHttp` instead.
 */
export async function tryUpgradePreviewWs(
  request: Request,
  server: BunServerLike,
  deps: PreviewProxyDeps,
): Promise<Response | undefined | null> {
  if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return null;
  }
  const handle = extractHandleFromHost(
    request.headers.get("host"),
    deps.baseDomain,
  );
  if (!handle) return null;

  const runner = await deps.getRunner();
  if (!runner) {
    return errorResponse(503, "preview proxy not configured");
  }

  const upstreamHttp = await runner.resolvePreviewUpstreamUrl(handle);
  if (!upstreamHttp) {
    return errorResponse(404, "sandbox not found");
  }

  const reqUrl = new URL(request.url);
  if (reqUrl.pathname.startsWith("/_decopilot_vm")) {
    return errorResponse(404, "not found");
  }

  const upstreamUrl = `${upstreamHttp.replace(/^http/, "ws")}${reqUrl.pathname}${reqUrl.search}`;
  const protocolHeader = request.headers.get("sec-websocket-protocol");
  const upstreamProtocols = protocolHeader
    ? protocolHeader
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const data: PreviewWsData = {
    kind: "preview",
    upstreamUrl,
    upstreamProtocols,
    pending: [],
    upstream: null,
    closed: false,
  };

  const upgraded = server.upgrade(request, { data });
  if (!upgraded) {
    return errorResponse(426, "upgrade failed");
  }
  return undefined;
}

/**
 * Idempotent shutdown for one side of the preview WS bridge. Marks the
 * connection as closed (so other event listeners stop forwarding), then
 * closes both client and upstream sockets — `try/catch` around each because
 * Bun + the WebSocket constructor both throw on close-after-close.
 */
function closePreviewBridge(
  ws: PreviewServerWebSocket,
  data: PreviewWsData,
  code: number,
  reason: string,
): void {
  if (data.closed) return;
  data.closed = true;
  try {
    ws.close(code, reason);
  } catch {}
  try {
    data.upstream?.close();
  } catch {}
}

/**
 * Bun WebSocket handler for the upgraded preview connection. Pumps frames
 * between the browser side (`ws`) and the upstream daemon (`ws.data.upstream`)
 * in both directions. Buffers inbound frames received before the upstream
 * dial completes — Bun delivers messages on `ws` immediately after upgrade,
 * and the upstream WebSocket handshake takes a non-zero number of ticks.
 */
export const previewWebSocketHandler = {
  open(ws: PreviewServerWebSocket) {
    const data = ws.data;
    if (!isPreviewWsData(data)) return;
    let upstream: WebSocket;
    try {
      upstream =
        data.upstreamProtocols.length > 0
          ? new WebSocket(data.upstreamUrl, data.upstreamProtocols)
          : new WebSocket(data.upstreamUrl);
    } catch (err) {
      console.warn(
        `[preview-ws] failed to dial upstream ${data.upstreamUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
      closePreviewBridge(ws, data, 1011, "upstream connect failed");
      return;
    }
    upstream.binaryType = "arraybuffer";
    data.upstream = upstream;

    upstream.addEventListener("open", () => {
      while (data.pending.length > 0) {
        const msg = data.pending.shift();
        if (msg !== undefined) upstream.send(msg);
      }
    });
    upstream.addEventListener("message", (ev: MessageEvent) => {
      if (data.closed) return;
      ws.send(ev.data as string | Uint8Array | ArrayBuffer);
    });
    upstream.addEventListener("close", (ev: CloseEvent) => {
      closePreviewBridge(ws, data, ev.code || 1000, ev.reason || "");
    });
    upstream.addEventListener("error", () => {
      closePreviewBridge(ws, data, 1011, "upstream error");
    });
  },
  message(
    ws: PreviewServerWebSocket,
    message: string | Uint8Array | ArrayBuffer,
  ) {
    const data = ws.data;
    if (!isPreviewWsData(data)) return;
    const upstream = data.upstream;
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.send(message);
      return;
    }
    // Cap the pre-handshake buffer. A blackholed upstream + a chatty client
    // (e.g. vite HMR firing while the daemon is still booting) would otherwise
    // grow this without bound. 1011 = "internal error" per RFC 6455.
    if (data.pending.length >= MAX_PENDING_FRAMES) {
      closePreviewBridge(ws, data, 1011, "preview ws backlog overflow");
      return;
    }
    data.pending.push(message);
  },
  close(ws: PreviewServerWebSocket) {
    const data = ws.data;
    if (!isPreviewWsData(data)) return;
    closePreviewBridge(ws, data, 1000, "");
  },
};

// Minimal structural types to avoid taking a hard dependency on `bun-types`
// in this module. The real Bun.ServerWebSocket / Bun.Server are wider but
// we only touch these members.
export interface PreviewServerWebSocket {
  data: PreviewWsData | unknown;
  send(data: string | Uint8Array | ArrayBuffer): number;
  close(code?: number, reason?: string): void;
}

export interface BunServerLike {
  upgrade(
    request: Request,
    options?: { data?: unknown; headers?: HeadersInit },
  ): boolean;
}
