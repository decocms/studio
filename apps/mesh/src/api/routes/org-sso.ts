/**
 * Organization-Level SSO Routes
 *
 * Provides:
 * - OIDC authorization code flow for org-level SSO
 * - SSO config management (CRUD) for org admins
 * - SSO session status checks
 */

import { Hono } from "hono";
import { setCookie, getCookie } from "hono/cookie";
import * as jose from "jose";
import { getSettings } from "../../settings";
import type { MeshContext } from "../../core/mesh-context";
import { ADMIN_ROLES } from "../../auth/roles";

type Variables = {
  meshContext: MeshContext;
};

export const createSsoRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();
  registerSsoRoutes(app);
  return app;
};

type SsoApp = Hono<{ Variables: Variables }>;

function registerSsoRoutes(app: SsoApp) {
  // ============================================================================
  // SSO Status Check
  // ============================================================================

  /**
   * Check if the current user has a valid SSO session for an organization.
   *
   * Route: GET /api/org-sso/status?orgId=<id>
   */
  app.get("/status", async (c) => {
    const ctx = c.get("meshContext") as MeshContext;
    if (!ctx.auth.user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const orgId = ctx.organization?.id;
    if (!orgId) {
      return c.json({ error: "Organization context required" }, 400);
    }

    // Verify user is a member of the organization
    const membership = await getOrgMembership(ctx, ctx.auth.user.id, orgId);
    if (!membership) {
      return c.json({ error: "Not a member of this organization" }, 403);
    }

    const ssoConfig = await ctx.storage.orgSsoConfig.getByOrgId(orgId);
    if (!ssoConfig || !ssoConfig.enforced) {
      return c.json({ ssoRequired: false });
    }

    const isValid = await ctx.storage.orgSsoSessions.isValid(
      ctx.auth.user.id,
      orgId,
    );

    return c.json({
      ssoRequired: true,
      authenticated: isValid,
      issuer: ssoConfig.issuer,
      domain: ssoConfig.domain,
    });
  });

  // ============================================================================
  // OIDC Authorization Flow
  // ============================================================================

  /**
   * Start OIDC authorization flow for org SSO.
   *
   * Route: GET /api/org-sso/authorize?orgId=<id>
   */
  app.get("/authorize", async (c) => {
    const ctx = c.get("meshContext") as MeshContext;
    if (!ctx.auth.user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const orgId = ctx.organization?.id;
    if (!orgId) {
      return c.json({ error: "Organization context required" }, 400);
    }

    // Verify user is a member of the organization
    const membership = await getOrgMembership(ctx, ctx.auth.user.id, orgId);
    if (!membership) {
      return c.json({ error: "Not a member of this organization" }, 403);
    }

    const ssoConfig = await ctx.storage.orgSsoConfig.getByOrgId(orgId);
    if (!ssoConfig) {
      return c.json({ error: "SSO not configured for this organization" }, 404);
    }

    // Discover OIDC endpoints
    const discovery = await discoverOIDC(
      ssoConfig.issuer,
      ssoConfig.discoveryEndpoint,
    );

    // Generate PKCE
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Generate state
    const state = crypto.randomUUID();

    // Store state + verifier in a secure cookie (short-lived)
    const stateData = JSON.stringify({
      state,
      codeVerifier,
      orgId,
      userId: ctx.auth.user.id,
    });

    setCookie(c, "org_sso_state", stateData, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/api/org-sso/callback",
      maxAge: 600, // 10 minutes
    });

    // Build authorization URL
    const params = new URLSearchParams({
      response_type: "code",
      client_id: ssoConfig.clientId,
      redirect_uri: `${ctx.baseUrl}/api/org-sso/callback`,
      scope: ssoConfig.scopes.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authUrl = `${discovery.authorization_endpoint}?${params.toString()}`;
    return c.redirect(authUrl);
  });

  /**
   * OIDC callback — exchanges code for tokens and creates SSO session.
   *
   * Route: GET /api/org-sso/callback
   */
  app.get("/callback", async (c) => {
    const ctx = c.get("meshContext") as MeshContext;

    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      return c.redirect(`/?sso_error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return c.redirect("/?sso_error=missing_code_or_state");
    }

    // Retrieve state from cookie
    const stateDataRaw = getCookie(c, "org_sso_state");
    if (!stateDataRaw) {
      return c.redirect("/?sso_error=state_expired");
    }

    // Clear the state cookie
    setCookie(c, "org_sso_state", "", {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/api/org-sso/callback",
      maxAge: 0,
    });

    let stateData: {
      state: string;
      codeVerifier: string;
      orgId: string;
      userId: string;
    };
    try {
      stateData = JSON.parse(stateDataRaw);
    } catch {
      return c.redirect("/?sso_error=invalid_state");
    }

    // Validate state
    if (stateData.state !== state) {
      return c.redirect("/?sso_error=state_mismatch");
    }

    // Verify the user is still authenticated
    if (!ctx.auth.user || ctx.auth.user.id !== stateData.userId) {
      return c.redirect("/?sso_error=session_expired");
    }

    const ssoConfig = await ctx.storage.orgSsoConfig.getByOrgId(
      stateData.orgId,
    );
    if (!ssoConfig) {
      return c.redirect("/?sso_error=sso_not_configured");
    }

    // Discover endpoints
    const discovery = await discoverOIDC(
      ssoConfig.issuer,
      ssoConfig.discoveryEndpoint,
    );

    // Exchange code for tokens
    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${ctx.baseUrl}/api/org-sso/callback`,
        client_id: ssoConfig.clientId,
        client_secret: ssoConfig.clientSecret,
        code_verifier: stateData.codeVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      console.error(
        "[org-sso] Token exchange failed:",
        await tokenResponse.text(),
      );
      return c.redirect("/?sso_error=token_exchange_failed");
    }

    const tokens = (await tokenResponse.json()) as {
      id_token?: string;
      access_token?: string;
    };

    if (!tokens.id_token) {
      return c.redirect("/?sso_error=no_id_token");
    }

    // Verify ID token
    try {
      const JWKS = jose.createRemoteJWKSet(new URL(discovery.jwks_uri));
      const { payload } = await jose.jwtVerify(tokens.id_token, JWKS, {
        issuer: ssoConfig.issuer,
        audience: ssoConfig.clientId,
      });

      // Verify the token email matches the authenticated user
      const tokenEmail = (payload.email as string)?.toLowerCase();
      const userEmail = ctx.auth.user.email?.toLowerCase();
      if (!tokenEmail || tokenEmail !== userEmail) {
        console.error(
          `[org-sso] Email mismatch: token=${tokenEmail}, user=${userEmail}`,
        );
        return c.redirect("/?sso_error=email_mismatch");
      }
    } catch (err) {
      console.error("[org-sso] ID token verification failed:", err);
      return c.redirect("/?sso_error=token_verification_failed");
    }

    // Create SSO session
    await ctx.storage.orgSsoSessions.upsert(ctx.auth.user.id, stateData.orgId);

    // Look up org slug via membership to redirect to the org
    const membership = await getOrgMembership(
      ctx,
      ctx.auth.user.id,
      stateData.orgId,
    );

    const redirectPath = membership?.orgSlug ? `/${membership.orgSlug}` : "/";
    return c.redirect(redirectPath);
  });

  // ============================================================================
  // SSO Config Management (Admin)
  // ============================================================================

  /**
   * Get SSO config for the current organization.
   *
   * Route: GET /api/org-sso/config
   */
  app.get("/config", async (c) => {
    const ctx = c.get("meshContext") as MeshContext;
    if (!ctx.auth.user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const orgId = ctx.organization?.id;
    if (!orgId) {
      return c.json({ error: "Organization context required" }, 400);
    }

    // Check admin role
    if (!isOrgAdmin(ctx)) {
      return c.json({ error: "Admin role required" }, 403);
    }

    const config = await ctx.storage.orgSsoConfig.getByOrgId(orgId);
    if (!config) {
      return c.json({ configured: false });
    }

    return c.json({
      configured: true,
      config: ctx.storage.orgSsoConfig.toPublic(config),
    });
  });

  /**
   * Create or update SSO config for the current organization.
   *
   * Route: POST /api/org-sso/config
   */
  app.post("/config", async (c) => {
    const ctx = c.get("meshContext") as MeshContext;
    if (!ctx.auth.user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const orgId = ctx.organization?.id;
    if (!orgId) {
      return c.json({ error: "Organization context required" }, 400);
    }

    if (!isOrgOwner(ctx)) {
      return c.json({ error: "Owner role required" }, 403);
    }

    const body = await c.req.json<{
      issuer: string;
      clientId: string;
      clientSecret: string;
      discoveryEndpoint?: string;
      scopes?: string[];
      domain: string;
      enforced?: boolean;
    }>();

    if (!body.issuer || !body.clientId || !body.domain) {
      return c.json(
        { error: "issuer, clientId, and domain are required" },
        400,
      );
    }

    // Client secret required for new configs, optional for updates
    const existingConfig = await ctx.storage.orgSsoConfig.getByOrgId(orgId);
    if (!existingConfig && !body.clientSecret) {
      return c.json(
        { error: "clientSecret is required for initial SSO setup" },
        400,
      );
    }

    // Use existing secret if not provided on update
    const clientSecret =
      body.clientSecret || existingConfig?.clientSecret || "";

    // Validate OIDC discovery endpoint is reachable
    try {
      await discoverOIDC(body.issuer, body.discoveryEndpoint);
    } catch (err) {
      return c.json(
        {
          error: "Failed to reach OIDC discovery endpoint",
          details: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }

    const config = await ctx.storage.orgSsoConfig.upsert(orgId, {
      issuer: body.issuer,
      clientId: body.clientId,
      clientSecret,
      discoveryEndpoint: body.discoveryEndpoint,
      scopes: body.scopes,
      domain: body.domain,
      enforced: body.enforced,
    });

    return c.json({
      success: true,
      config: ctx.storage.orgSsoConfig.toPublic(config),
    });
  });

  /**
   * Toggle SSO enforcement for the current organization.
   *
   * Route: POST /api/org-sso/config/enforce
   */
  app.post("/config/enforce", async (c) => {
    const ctx = c.get("meshContext") as MeshContext;
    if (!ctx.auth.user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const orgId = ctx.organization?.id;
    if (!orgId) {
      return c.json({ error: "Organization context required" }, 400);
    }

    if (!isOrgOwner(ctx)) {
      return c.json({ error: "Owner role required" }, 403);
    }

    const body = await c.req.json<{ enforced: boolean }>();

    // Verify config exists before enforcing
    const existing = await ctx.storage.orgSsoConfig.getByOrgId(orgId);
    if (!existing) {
      return c.json({ error: "SSO must be configured before enforcing" }, 400);
    }

    await ctx.storage.orgSsoConfig.setEnforced(orgId, body.enforced);

    return c.json({ success: true, enforced: body.enforced });
  });

  /**
   * Delete SSO config for the current organization.
   *
   * Route: DELETE /api/org-sso/config
   */
  app.delete("/config", async (c) => {
    const ctx = c.get("meshContext") as MeshContext;
    if (!ctx.auth.user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const orgId = ctx.organization?.id;
    if (!orgId) {
      return c.json({ error: "Organization context required" }, 400);
    }

    if (!isOrgOwner(ctx)) {
      return c.json({ error: "Owner role required" }, 403);
    }

    await ctx.storage.orgSsoConfig.delete(orgId);
    return c.json({ success: true });
  });
}

// ============================================================================
// Helpers
// ============================================================================

interface OIDCDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

// Simple in-memory cache for OIDC discovery documents
const discoveryCache = new Map<
  string,
  { doc: OIDCDiscovery; expiresAt: number }
>();

/**
 * Validate that a URL is safe for server-side fetching (SSRF prevention).
 * Enforces HTTPS and blocks private/link-local IP ranges. Local mode opts
 * in to HTTP and loopback so developers can point at a local Keycloak/etc.
 */
function validateOIDCUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Local mode opts in to HTTP + loopback for local OIDC providers.
  const allowHttp = getSettings().localMode;
  if (
    parsed.protocol !== "https:" &&
    !(allowHttp && parsed.protocol === "http:")
  ) {
    throw new Error(`OIDC URL must use HTTPS: ${url}`);
  }

  // Block private and link-local IP ranges
  const host = parsed.hostname;
  const privatePatterns = [
    /^127\./, // loopback (allowed in local mode below)
    /^10\./, // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
    /^192\.168\./, // 192.168.0.0/16
    /^169\.254\./, // link-local (cloud metadata)
    /^0\./, // 0.0.0.0/8
    /^\[::1\]$/, // IPv6 loopback
    /^\[fd/, // IPv6 unique local
    /^\[fe80:/, // IPv6 link-local
    /^localhost$/i, // localhost hostname
  ];

  // Allow loopback in local mode for local OIDC providers (e.g. Keycloak)
  const isLoopback = /^127\.|^\[::1\]$|^localhost$/i.test(host);
  if (allowHttp && isLoopback) {
    return;
  }

  for (const pattern of privatePatterns) {
    if (pattern.test(host)) {
      throw new Error(
        `OIDC URL must not point to a private network address: ${host}`,
      );
    }
  }
}

async function discoverOIDC(
  issuer: string,
  discoveryEndpoint?: string | null,
): Promise<OIDCDiscovery> {
  const cacheKey = discoveryEndpoint || issuer;
  const cached = discoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.doc;
  }

  const url =
    discoveryEndpoint ||
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;

  validateOIDCUrl(url);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `OIDC discovery failed: ${response.status} ${response.statusText}`,
    );
  }

  const doc = (await response.json()) as OIDCDiscovery;

  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error("OIDC discovery document missing required endpoints");
  }

  // Validate all endpoints from the discovery document against SSRF
  validateOIDCUrl(doc.authorization_endpoint);
  validateOIDCUrl(doc.token_endpoint);
  validateOIDCUrl(doc.jwks_uri);

  // Cache for 1 hour
  discoveryCache.set(cacheKey, {
    doc,
    expiresAt: Date.now() + 3600 * 1000,
  });

  return doc;
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function getOrgMembership(
  ctx: MeshContext,
  userId: string,
  orgId: string,
): Promise<{ orgSlug: string; role: string } | null> {
  const row = await ctx.db
    .selectFrom("member")
    .innerJoin("organization", "organization.id", "member.organizationId")
    .select(["organization.slug as orgSlug", "member.role"])
    .where("member.userId", "=", userId)
    .where("member.organizationId", "=", orgId)
    .executeTakeFirst();
  return row ?? null;
}

function isOrgAdmin(ctx: MeshContext): boolean {
  const role = ctx.auth.user?.role;
  if (!role) return false;
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

function isOrgOwner(ctx: MeshContext): boolean {
  return ctx.auth.user?.role === "owner";
}
