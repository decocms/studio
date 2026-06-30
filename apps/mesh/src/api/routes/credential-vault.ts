import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import { getValidDownstreamAccessToken } from "@/oauth/token-refresh";
import { CREDENTIAL_ACCESS_TOKEN_READ_SCOPE } from "@/storage/connection-credential-vault";
import { DownstreamTokenStorage } from "@/storage/downstream-token";

type Variables = {
  meshContext: StudioContext;
};

function bearerToken(value: string | undefined): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function serializeExpiresAt(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export const createCredentialVaultRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/vault/connections/:connectionId/access-token", async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const ctx = c.get("meshContext");
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 403);
    }

    const workloadToken =
      await ctx.storage.connectionCredentialVault.authenticateWorkloadToken(
        token,
      );
    if (!workloadToken || workloadToken.organizationId !== organizationId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const subject = await ctx.storage.connections.findById(
      workloadToken.subjectConnectionId,
      organizationId,
    );
    if (!subject || subject.status !== "active") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const targetConnectionId = c.req.param("connectionId");
    const hasGrant = await ctx.storage.connectionCredentialVault.hasGrant({
      organizationId,
      subjectConnectionId: workloadToken.subjectConnectionId,
      targetConnectionId,
      scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
    });
    if (!hasGrant) {
      return c.json({ error: "Forbidden" }, 403);
    }

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

  return app;
};
