/**
 * `/api/links/*` HTTP routes
 *
 * Implements the four endpoints from the link spec:
 *   - `POST /api/links` (register) — session-authed; mints a fresh
 *     `linkSecret`, persists the RAW value in the registry, returns it to
 *     the caller. Returns 409 if another `machineId` already has an
 *     active entry for this user.
 *   - `POST /api/links/heartbeat` — authed via the `X-Link-Secret` header
 *     against the stored `linkSecret`; refreshes the entry's TTL.
 *   - `DELETE /api/links/me` — same `X-Link-Secret` auth as heartbeat;
 *     graceful shutdown.
 *
 * The link daemon presents its `linkSecret` in `X-Link-Secret` rather than
 * `Authorization: Bearer …` so it never enters Better Auth's API-key
 * validator (which logs `INVALID_API_KEY` for every unknown bearer it
 * sees — a per-heartbeat false positive when the secret isn't actually
 * an API key).
 *   - `GET /api/links/me` — session-authed; status for the admin UI.
 *
 * The `linkSecret` field stored in `LinkRegistry` is the RAW bearer
 * secret. HMAC signing requires symmetric key material on both sides; a
 * hash-at-rest construction is impractical without shipping the cluster
 * signing key to the link binary (which defeats the point of HMAC). v1
 * accepts that NATS operators within the cluster's trust boundary can
 * see working bearer tokens; mitigations are (a) 30s TTL bounds the leak
 * window, (b) rotation = re-register. v2 hardening will encrypt at rest
 * with a cluster KMS key.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  LINK_PROTOCOL_VERSION,
  MIN_SUPPORTED_LINK_PROTOCOL,
  type LinkEntry,
  isVersionAcceptable,
  registrationPayloadSchema,
} from "./protocol";
import type { Env, Hono } from "hono";
import type { BlankSchema } from "hono/types";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { LinkRegistry } from "./link-registry";

export interface LinksRoutesDeps<E extends Env = Env> {
  linkRegistry: LinkRegistry;
  /**
   * Pluggable so tests can inject a session. Returns userSub (the stable
   * Better Auth user id) or null when unauthenticated.
   */
  getAuthenticatedUserSub: (c: Context<E>) => string | null;
  /** When true, accept `tunnelUrl: http://localhost:*` from the body. */
  allowLocalhostLinks: boolean;
}

function expectedTunnelDomain(userSub: string): string {
  return `https://link-${userSub}.deco.host`;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function isLocalhostUrl(raw: string): boolean {
  try {
    return new URL(raw).hostname === "localhost";
  } catch {
    return false;
  }
}

export function registerLinksRoutes<E extends Env = Env>(
  app: Hono<E, BlankSchema, "/">,
  deps: LinksRoutesDeps<E>,
): void {
  // POST /api/links — register
  app.post("/api/links", async (c) => {
    const userSub = deps.getAuthenticatedUserSub(c);
    if (!userSub) throw new HTTPException(401, { message: "no session" });

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: "invalid json" });
    }
    const parsed = registrationPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.message });
    }
    const payload = parsed.data;

    if (!isVersionAcceptable(payload.protocolVersion)) {
      return c.json(
        {
          code: "upgrade_required",
          requiredVersion: MIN_SUPPORTED_LINK_PROTOCOL,
          installHint: "bunx decocms@latest link",
        },
        426,
      );
    }

    // Determine the canonical tunnel URL.
    //   - Prod: derived from the authenticated userSub (body is ignored).
    //   - Dev (allowLocalhostLinks=1): honor a `http://localhost:*` body
    //     value so the link daemon can advertise the dev reverse proxy.
    const tunnelUrl: string = (() => {
      if (
        payload.tunnelUrl &&
        isLocalhostUrl(payload.tunnelUrl) &&
        deps.allowLocalhostLinks
      ) {
        return payload.tunnelUrl;
      }
      return expectedTunnelDomain(userSub);
    })();

    // 409 if a different machineId is already active.
    const existing = await deps.linkRegistry.get(userSub);
    if (existing && existing.machineId !== payload.machineId) {
      return c.json(
        { code: "another_machine_active", activeMachineId: existing.machineId },
        409,
      );
    }

    // Re-registering with the same machineId mints a fresh linkSecret and
    // overwrites the entry. The previous secret is immediately invalidated —
    // any in-flight heartbeat from an older link process will start 401-ing
    // after this point. Documented behavior: "rotation = re-register"
    // (link-protocol schemas.ts, linkSecret JSDoc).
    const linkSecretRaw = randomBytes(32).toString("base64url");

    const entry: LinkEntry = {
      machineId: payload.machineId,
      tunnelUrl,
      linkSecret: linkSecretRaw,
      cliVersion: payload.cliVersion,
      protocolVersion: payload.protocolVersion,
      capabilities: payload.capabilities,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };

    await deps.linkRegistry.put(userSub, entry);
    return c.json({ linkSecret: linkSecretRaw });
  });

  // POST /api/links/heartbeat — authenticated by X-Link-Secret + X-Mesh-User-Sub
  //
  // The link binary loses its OAuth session after registration (it doesn't
  // hold an active session cookie or API key). Heartbeat identifies the user
  // via the X-Mesh-User-Sub header and proves identity via the linkSecret
  // presented in X-Link-Secret. The cluster verifies it matches the stored
  // value for that userSub.
  app.post("/api/links/heartbeat", async (c) => {
    const userSub = c.req.header("x-mesh-user-sub");
    if (!userSub) {
      throw new HTTPException(400, { message: "missing X-Mesh-User-Sub" });
    }
    const presented = c.req.header("x-link-secret");
    if (!presented) {
      throw new HTTPException(401, { message: "missing X-Link-Secret" });
    }

    const existing = await deps.linkRegistry.get(userSub);
    if (!existing) throw new HTTPException(401, { message: "no link" });
    if (!timingSafeEqualStrings(existing.linkSecret, presented)) {
      throw new HTTPException(401, { message: "bad secret" });
    }

    // Re-put refreshes the TTL.
    await deps.linkRegistry.put(userSub, existing);
    return c.body(null, 204);
  });

  // DELETE /api/links/me — graceful shutdown, same auth model as heartbeat
  app.delete("/api/links/me", async (c) => {
    const userSub = c.req.header("x-mesh-user-sub");
    if (!userSub) {
      throw new HTTPException(400, { message: "missing X-Mesh-User-Sub" });
    }
    const presented = c.req.header("x-link-secret");
    if (!presented) {
      throw new HTTPException(401, { message: "missing X-Link-Secret" });
    }
    const existing = await deps.linkRegistry.get(userSub);
    if (!existing) return c.body(null, 204); // idempotent — already gone
    if (!timingSafeEqualStrings(existing.linkSecret, presented)) {
      throw new HTTPException(401, { message: "bad secret" });
    }
    await deps.linkRegistry.delete(userSub);
    return c.body(null, 204);
  });

  // GET /api/links/me — UI status
  app.get("/api/links/me", async (c) => {
    const userSub = deps.getAuthenticatedUserSub(c);
    if (!userSub) throw new HTTPException(401, { message: "no session" });
    const link = await deps.linkRegistry.get(userSub);
    if (!link) return c.json({ status: "offline" });
    return c.json({
      status: "online",
      capabilities: link.capabilities,
      machineId: link.machineId,
      cliVersion: link.cliVersion,
      currentProtocolVersion: LINK_PROTOCOL_VERSION,
      reportedProtocolVersion: link.protocolVersion,
    });
  });
}
