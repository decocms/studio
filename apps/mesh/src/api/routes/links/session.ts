import { Hono } from "hono";
import type { ConnectionType } from "@nats-io/jwt";
import { getSettings } from "@/settings";
import type { StudioContext } from "@/core/studio-context";
import {
  buildDaemonCredentialPermissions,
  buildLinkSessionResponse,
  buildUserTunnelHostname,
} from "@/links/link-session";
import { issueNatsCredentials } from "@/links/nats-credentials";

type Variables = {
  studioContext: StudioContext;
};

const unavailable = () => ({ error: "link session unavailable" });

/**
 * Allowed NATS connection types for the minted daemon JWT, derived from the
 * public URL scheme. Production hands the daemon a `wss://` URL (WebSocket
 * listener) → WEBSOCKET only. Local dev hands a `nats://` TCP URL because the
 * Node `nats` transport speaks raw TCP; the daemon then needs STANDARD (and we
 * keep WEBSOCKET too so a future WS-capable client still works).
 */
export function allowedConnectionTypesForUrl(
  publicUrl: string,
): ConnectionType[] {
  const isWebSocket = /^wss?:\/\//i.test(publicUrl.trim());
  return isWebSocket ? ["WEBSOCKET"] : ["STANDARD", "WEBSOCKET"];
}

export function createLinkSessionRoutes() {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/links/session", async (c) => {
    const ctx = c.get("studioContext");
    const userId = ctx.auth?.user?.id;

    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const settings = getSettings();

    // Both local dev and production take the real mint path: the cluster runs
    // NATS in operator (decentralized-JWT) mode and mints a short-lived,
    // subject-scoped per-user JWT signed with the tunnel account's signing key.
    // In dev these settings come from the operator config ensure-services
    // provisions; in prod they come from the deployment env.
    //
    // When JWT credentials are NOT configured (e.g. a plain NATS server without
    // operator mode, used in resilience-test environments), the session is issued
    // without credentials so the daemon connects anonymously.
    if (!settings.natsTunnelPublicEnabled) {
      return c.json(unavailable(), 503);
    }
    if (!settings.natsPublicUrl) {
      return c.json(unavailable(), 503);
    }

    // Production guard: in non-local mode, missing JWT credentials mean the
    // operator-mode NATS has not been configured → 503. In local/test mode
    // (plain NATS without operator auth), allow anonymous connections.
    if (!settings.natsAccountJwt || !settings.natsAccountSigningKey) {
      if (!settings.localMode) {
        return c.json(unavailable(), 503);
      }
    }

    const tunnelHostname = buildUserTunnelHostname(userId);
    let credentials: string | undefined;
    if (settings.natsAccountJwt && settings.natsAccountSigningKey) {
      const expiresAt = new Date(
        Date.now() + settings.natsTunnelSessionTtlSeconds * 1000,
      );
      credentials = await issueNatsCredentials({
        accountJwt: settings.natsAccountJwt,
        accountSigningKey: settings.natsAccountSigningKey,
        expiresAt,
        permissions: buildDaemonCredentialPermissions(tunnelHostname),
        userId,
        allowedConnectionTypes: allowedConnectionTypesForUrl(
          settings.natsPublicUrl,
        ),
      });
    }

    return c.json(
      buildLinkSessionResponse({
        publicUrl: settings.natsPublicUrl,
        userId,
        ttlSeconds: settings.natsTunnelSessionTtlSeconds,
        credentials,
      }),
    );
  });

  return app;
}
