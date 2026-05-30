/**
 * Downstream Token API Routes
 *
 * Handles OAuth token management for downstream MCP connections.
 * Called from frontend after OAuth authentication to persist tokens.
 */

import { Hono } from "hono";
import type { MeshContext } from "../../core/mesh-context";
import { resolveOriginTokenEndpoint } from "../../oauth/resolve-token-endpoint";
import {
  DownstreamTokenStorage,
  type DownstreamTokenData,
} from "../../storage/downstream-token";

// Define Hono variables type
type Variables = {
  meshContext: MeshContext;
};

export const createDownstreamTokenRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  /**
   * POST /api/connections/:connectionId/oauth-token
   *
   * Save OAuth tokens after authentication.
   * Called from frontend after OAuth flow completes.
   */
  app.post("/connections/:connectionId/oauth-token", async (c) => {
    const ctx = c.get("meshContext");
    const connectionId = c.req.param("connectionId");

    // Require authentication
    const userId = ctx.auth.user?.id ?? ctx.auth.apiKey?.userId ?? null;
    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 403);
    }

    // Verify connection exists and user has access
    const connection = await ctx.storage.connections.findById(
      connectionId,
      organizationId,
    );
    if (!connection) {
      return c.json({ error: "Connection not found" }, 404);
    }

    // Parse request body
    const body = await c.req.json<{
      accessToken: string;
      refreshToken?: string | null;
      expiresIn?: number | null;
      scope?: string | null;
      clientId?: string | null;
      clientSecret?: string | null;
      tokenEndpoint?: string | null;
    }>();

    if (!body.accessToken) {
      return c.json({ error: "accessToken is required" }, 400);
    }

    if (body.tokenEndpoint) {
      let url: URL;
      try {
        url = new URL(body.tokenEndpoint);
      } catch {
        return c.json({ error: "tokenEndpoint must be a valid URL" }, 400);
      }

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return c.json({ error: "tokenEndpoint must be an http(s) URL" }, 400);
      }
    }

    // Calculate expiry time
    const expiresAt = body.expiresIn
      ? new Date(Date.now() + body.expiresIn * 1000)
      : null;

    // If tokenEndpoint is a proxy URL (goes through /oauth-proxy/), resolve the
    // origin's actual token endpoint so server-side refresh calls origin directly
    // instead of making a self-referential call through the proxy.
    let resolvedTokenEndpoint = body.tokenEndpoint ?? null;
    if (
      resolvedTokenEndpoint?.includes("/oauth-proxy/") &&
      connection.connection_url
    ) {
      try {
        const originEndpoint = await resolveOriginTokenEndpoint(
          connection.connection_url,
        );
        if (originEndpoint) {
          // Apply same URL/protocol validation as the user-supplied tokenEndpoint
          try {
            const u = new URL(originEndpoint);
            if (u.protocol === "http:" || u.protocol === "https:") {
              resolvedTokenEndpoint = originEndpoint;
            }
          } catch {
            // Invalid URL from discovery — keep proxy URL as fallback
          }
        }
      } catch {
        // Keep proxy URL as fallback
      }
    }

    // Create storage instance
    const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);

    // Save token
    const tokenData: DownstreamTokenData = {
      connectionId,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken ?? null,
      scope: body.scope ?? null,
      expiresAt,
      clientId: body.clientId ?? null,
      clientSecret: body.clientSecret ?? null,
      tokenEndpoint: resolvedTokenEndpoint,
    };

    const token = await tokenStorage.upsert(tokenData);

    return c.json({
      success: true,
      expiresAt: token.expiresAt,
    });
  });

  /**
   * DELETE /api/connections/:connectionId/oauth-token
   *
   * Delete OAuth token for a connection.
   */
  app.delete("/connections/:connectionId/oauth-token", async (c) => {
    const ctx = c.get("meshContext");
    const connectionId = c.req.param("connectionId");

    const userId = ctx.auth.user?.id ?? ctx.auth.apiKey?.userId ?? null;
    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 403);
    }

    // Verify connection exists and belongs to the user's organization
    const connection = await ctx.storage.connections.findById(
      connectionId,
      organizationId,
    );
    if (!connection) {
      return c.json({ error: "Connection not found" }, 404);
    }

    const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
    await tokenStorage.delete(connectionId);

    return c.json({ success: true });
  });

  /**
   * GET /api/connections/:connectionId/oauth-token/status
   *
   * Check if there's a valid cached token for a connection.
   */
  app.get("/connections/:connectionId/oauth-token/status", async (c) => {
    const ctx = c.get("meshContext");
    const connectionId = c.req.param("connectionId");

    const userId = ctx.auth.user?.id ?? ctx.auth.apiKey?.userId ?? null;
    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 403);
    }

    // Verify connection exists and belongs to the user's organization
    const connection = await ctx.storage.connections.findById(
      connectionId,
      organizationId,
    );
    if (!connection) {
      return c.json({ error: "Connection not found" }, 404);
    }

    const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
    const token = await tokenStorage.get(connectionId);

    if (!token) {
      return c.json({
        hasToken: false,
        isExpired: true,
        canRefresh: false,
      });
    }

    const isExpired = tokenStorage.isExpired(token);
    const canRefresh = !!token.refreshToken && !!token.tokenEndpoint;

    return c.json({
      hasToken: true,
      isExpired,
      canRefresh,
      expiresAt: token.expiresAt,
    });
  });

  return app;
};
