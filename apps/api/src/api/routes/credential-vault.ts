import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { StudioContext } from "@/core/studio-context";
import { getValidDownstreamAccessToken } from "@/oauth/token-refresh";
import {
  CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
  CREDENTIAL_CONFIGURATION_READ_SCOPE,
} from "@/storage/connection-credential-vault";
import { DownstreamTokenStorage } from "@/storage/downstream-token";

type Variables = {
  studioContext: StudioContext;
};

export function bearerToken(value: string | undefined): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/** Constant-time string compare (for the service token). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * A trusted internal service (e.g. commerce-discovery's credential resolver)
 * presenting this shared token may lease ANY connection in the org resolved from
 * the path — bypassing the per-connection grant. It's the service-scoped
 * equivalent of a workload token; the org in the URL still bounds it. Rotate via
 * env. Absent ⇒ feature off (only workload-token + grant is accepted).
 */
export function isVaultServiceToken(token: string): boolean {
  const svc = process.env.VAULT_SERVICE_TOKEN;
  return !!svc && safeEqual(token, svc);
}

function serializeExpiresAt(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function parseConfigurationScopes(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === "string");
  }
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((scope): scope is string => typeof scope === "string")
      : [];
  } catch {
    return [];
  }
}

async function authorizeVaultRequest(
  c: Context<{ Variables: Variables }>,
  targetConnectionId: string,
  scope: string,
): Promise<
  | { ok: true; ctx: StudioContext; organizationId: string }
  | { ok: false; response: Response }
> {
  const token = bearerToken(c.req.header("authorization"));
  if (!token) {
    return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
  }

  const ctx = c.get("studioContext");
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    return {
      ok: false,
      response: c.json({ error: "Organization context required" }, 403),
    };
  }

  // Trusted internal service: skip workload-token + per-connection grant. Still
  // bounded to the org resolved from the path (the target lookups below filter
  // by organizationId), so it can't reach another org's connections.
  if (isVaultServiceToken(token)) {
    return { ok: true, ctx, organizationId };
  }

  const workloadToken =
    await ctx.storage.connectionCredentialVault.authenticateWorkloadToken(
      token,
    );
  if (!workloadToken || workloadToken.organizationId !== organizationId) {
    return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
  }

  const subject = await ctx.storage.connections.findById(
    workloadToken.subjectConnectionId,
    organizationId,
  );
  if (!subject || subject.status !== "active") {
    return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
  }

  const hasGrant = await ctx.storage.connectionCredentialVault.hasGrant({
    organizationId,
    subjectConnectionId: workloadToken.subjectConnectionId,
    targetConnectionId,
    scope,
  });
  if (!hasGrant) {
    return { ok: false, response: c.json({ error: "Forbidden" }, 403) };
  }

  return { ok: true, ctx, organizationId };
}

export const createCredentialVaultRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/vault/connections/:connectionId/access-token", async (c) => {
    const targetConnectionId = c.req.param("connectionId");
    const authz = await authorizeVaultRequest(
      c,
      targetConnectionId,
      CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
    );
    if (!authz.ok) {
      return authz.response;
    }

    const { ctx, organizationId } = authz;
    const target = await ctx.storage.connections.findById(
      targetConnectionId,
      organizationId,
    );
    if (!target || target.status !== "active") {
      return c.json({ error: "Connection not found" }, 404);
    }

    const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
    const result = await getValidDownstreamAccessToken({
      connectionId: targetConnectionId,
      connectionUrl: target.connection_url,
      tokenStorage,
    });

    if (result.state === "missing") {
      // Fall back to a static bearer token stored on the connection itself
      // (token-auth MCPs like Shopify that never run an OAuth flow, so nothing
      // is ever written to downstream_tokens). Mirrors the MCP proxy's own
      // resolution order — OAuth first, then connection_token (see
      // mcp-clients/outbound/headers.ts) — so static-token connections are
      // first-class in the vault too. The response shape is unchanged; only
      // `type` differs so callers can tell the lanes apart.
      if (target.connection_token) {
        c.header("Cache-Control", "no-store");
        c.header("Pragma", "no-cache");
        return c.json({
          type: "static_token",
          tokenType: "Bearer",
          accessToken: target.connection_token,
          expiresAt: null,
          scope: null,
        });
      }
      return c.json({ error: "Downstream token not found" }, 409);
    }
    if (
      result.state === "expired_without_refresh" ||
      result.state === "refresh_failed"
    ) {
      return c.json({ error: "Downstream token refresh failed" }, 424);
    }

    const downstreamToken = await tokenStorage.get(targetConnectionId);
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    return c.json({
      type: "oauth_access_token",
      tokenType: "Bearer",
      accessToken: result.accessToken,
      expiresAt: serializeExpiresAt(downstreamToken?.expiresAt ?? null),
      scope: downstreamToken?.scope ?? null,
    });
  });

  app.post("/vault/connections/:connectionId/configuration", async (c) => {
    const targetConnectionId = c.req.param("connectionId");
    const authz = await authorizeVaultRequest(
      c,
      targetConnectionId,
      CREDENTIAL_CONFIGURATION_READ_SCOPE,
    );
    if (!authz.ok) {
      return authz.response;
    }

    const { ctx, organizationId } = authz;
    const target = await ctx.db
      .selectFrom("connections")
      .select(["status", "configuration_state", "configuration_scopes"])
      .where("id", "=", targetConnectionId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    if (!target || target.status !== "active") {
      return c.json({ error: "Connection not found" }, 404);
    }

    let configurationState: Record<string, unknown> = {};
    if (target.configuration_state) {
      try {
        const decryptedJson = await ctx.vault.decrypt(
          target.configuration_state,
        );
        const parsed = JSON.parse(decryptedJson) as unknown;
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new Error("MCP configuration state is not an object");
        }
        configurationState = parsed as Record<string, unknown>;
      } catch {
        return c.json(
          { error: "MCP configuration could not be decrypted" },
          424,
        );
      }
    }

    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    return c.json({
      type: "mcp_configuration",
      state: configurationState,
      scopes: parseConfigurationScopes(target.configuration_scopes),
    });
  });

  return app;
};
