/**
 * WS uplink upgrade (transport-layer spec §5.2) — return-leg only, phase 1.
 *
 * `GET /api/links/uplink` upgrades to a WebSocket. Auth: bearer in the upgrade
 * `Authorization` header OR `Sec-WebSocket-Protocol` (form `bearer.<token>` —
 * browsers can't set Authorization on a WS handshake, the daemon can). Resolved
 * by an injected resolver — the same dual-auth `/links/me` uses (resolveLinkBearer).
 * Reject → 401 Response. Mirrors preview-proxy.ts's tryUpgradePreviewWs.
 *
 * Keepalive: ping < 350s (AWS-NLB idle drop). UPLINK_KEEPALIVE_MS = 300s.
 *
 * Returns from tryUpgradeUplinkWs:
 *   - null      → not an uplink WS request (caller falls through to Hono)
 *   - Response  → pre-upgrade error (401 unauthorized / 426 upgrade failed)
 *   - undefined → upgraded (caller returns nothing)
 */

export const UPLINK_PATH = "/api/links/uplink";
export const UPLINK_KEEPALIVE_MS = 300_000;

export interface UplinkWsData {
  kind: "uplink";
  userSub: string;
}

export function isUplinkWsData(data: unknown): data is UplinkWsData {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "uplink"
  );
}

/** Bearer from Authorization, else the `bearer.<token>` WS subprotocol. */
export function parseUplinkBearer(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return (m[1] ?? "").trim();
  const proto = request.headers.get("sec-websocket-protocol") ?? "";
  for (const p of proto.split(",")) {
    const t = p.trim();
    if (t.startsWith("bearer.")) return t.slice("bearer.".length);
  }
  return null;
}

interface UplinkUpgradeServer {
  upgrade(request: Request, opts: { data: UplinkWsData }): boolean;
}

export interface UplinkUpgradeDeps {
  resolve: (token: string) => Promise<string | null>;
}

export async function tryUpgradeUplinkWs(
  request: Request,
  server: UplinkUpgradeServer,
  deps: UplinkUpgradeDeps,
): Promise<Response | undefined | null> {
  if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return null;
  }
  const url = new URL(request.url);
  if (url.pathname !== UPLINK_PATH) return null;

  const token = parseUplinkBearer(request);
  if (!token) return new Response("unauthorized", { status: 401 });
  const userSub = await deps.resolve(token);
  if (!userSub) return new Response("unauthorized", { status: 401 });

  const upgraded = server.upgrade(request, {
    data: { kind: "uplink", userSub },
  });
  if (!upgraded) return new Response("upgrade failed", { status: 426 });
  return undefined;
}
