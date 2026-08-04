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

  // Batch lease for the vault SERVICE lane only (decocms/reports resolves up
  // to five providers per run): configuration + access token for N connections
  // in one round-trip. Per-item failures never fail the batch — every requested
  // id gets an entry, with `error` set when that connection can't be leased.
  app.post("/vault/connections/batch", async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !isVaultServiceToken(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const ctx = c.get("studioContext");
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 403);
    }

    const body = (await c.req.json().catch(() => null)) as {
      connectionIds?: unknown;
    } | null;
    const ids = Array.isArray(body?.connectionIds)
      ? [...new Set(body.connectionIds)].filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        )
      : [];
    if (ids.length === 0 || ids.length > 20) {
      return c.json(
        { error: "connectionIds must be a non-empty string array (max 20)" },
        400,
      );
    }

    // ONE query for all connections (decrypted entities: configuration_state
    // + connection_token) and one for which of them hold a downstream OAuth
    // token — only those go through the per-token refresh path; static-token
    // connections resolve with no further reads.
    const { items } = await ctx.storage.connections.list(organizationId, {
      includeVirtual: true,
      where: { field: ["id"], operator: "in", value: ids },
      limit: ids.length,
    });
    const byId = new Map(items.map((item) => [item.id, item]));
    const withDownstreamToken = new Set(
      (
        await ctx.db
          .selectFrom("downstream_tokens")
          .select("connectionId")
          .where("connectionId", "in", ids)
          .execute()
      ).map((row) => row.connectionId),
    );
    // Raw (still-encrypted) configuration_state + connection_token, so a
    // decrypt failure can be told apart from "not set" below —
    // `connections.list()` silently maps either decrypt failure to `null`,
    // same as an unset value.
    const rawById = new Map(
      (
        await ctx.db
          .selectFrom("connections")
          .select(["id", "configuration_state", "connection_token"])
          .where("id", "in", ids)
          .where("organization_id", "=", organizationId)
          .execute()
      ).map((row) => [row.id, row]),
    );

    const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
    const out: Record<string, unknown> = {};
    await Promise.all(
      ids.map(async (id) => {
        try {
          const target = byId.get(id);
          if (!target || target.status !== "active") {
            out[id] = { error: "Connection not found" };
            return;
          }
          if (
            rawById.get(id)?.configuration_state &&
            !target.configuration_state
          ) {
            // Mirrors the single-connection /configuration route: don't mask
            // a decrypt failure as an empty configuration.
            out[id] = { error: "MCP configuration could not be decrypted" };
            return;
          }
          const configuration = {
            type: "mcp_configuration",
            state: target.configuration_state ?? {},
            scopes: target.configuration_scopes ?? [],
          };
          let accessToken: Record<string, unknown> | null = null;
          if (withDownstreamToken.has(id)) {
            const result = await getValidDownstreamAccessToken({
              connectionId: id,
              connectionUrl: target.connection_url,
              tokenStorage,
            });
            if (result.state === "valid" || result.state === "refreshed") {
              const downstreamToken = await tokenStorage.get(id);
              accessToken = {
                type: "oauth_access_token",
                tokenType: "Bearer",
                accessToken: result.accessToken,
                expiresAt: serializeExpiresAt(
                  downstreamToken?.expiresAt ?? null,
                ),
                scope: downstreamToken?.scope ?? null,
              };
            }
            // refresh_failed/expired ⇒ null, same as the single route's 424.
          } else if (target.connection_token) {
            // Static-token MCPs (e.g. Shopify): bearer on the connection.
            accessToken = {
              type: "static_token",
              tokenType: "Bearer",
              accessToken: target.connection_token,
              expiresAt: null,
              scope: null,
            };
          } else if (rawById.get(id)?.connection_token) {
            // Same masking as configuration_state above, for the static-token
            // lane: don't report "no token" when it's actually undecryptable.
            out[id] = { error: "Connection token could not be decrypted" };
            return;
          }
          out[id] = { configuration, accessToken };
        } catch (err) {
          out[id] = {
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    return c.json(out);
  });

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
      // Static-token MCPs (e.g. Shopify): the bearer lives on connection_token.
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
      // `connections.findById` decrypts eagerly and silently maps a
      // connection_token decrypt failure to null, same as an unset value —
      // check the raw ciphertext so that case reports 424, not "not found".
      const raw = await ctx.db
        .selectFrom("connections")
        .select("connection_token")
        .where("id", "=", targetConnectionId)
        .where("organization_id", "=", organizationId)
        .executeTakeFirst();
      if (raw?.connection_token) {
        return c.json(
          { error: "Connection token could not be decrypted" },
          424,
        );
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
