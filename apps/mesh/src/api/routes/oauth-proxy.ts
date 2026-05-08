/**
 * OAuth Proxy Routes
 *
 * Proxies OAuth discovery and token flows to origin MCP servers.
 * This avoids CORS issues when the frontend needs to authenticate
 * with downstream MCPs that require OAuth.
 *
 * Routes:
 * - /.well-known/oauth-protected-resource/mcp/:connectionId
 * - /mcp/:connectionId/.well-known/oauth-protected-resource
 * - /.well-known/oauth-authorization-server/oauth-proxy/:connectionId
 * - /oauth-proxy/:connectionId/:endpoint (authorize, token, register)
 */

import { Hono } from "hono";
import { ContextFactory } from "../../core/context-factory";
import type { MeshContext } from "../../core/mesh-context";

// Define Hono variables type
type Variables = {
  meshContext: MeshContext;
};

type HonoEnv = { Variables: Variables };

// ============================================================================
// Constants
// ============================================================================

/**
 * HTTP status codes that indicate the server doesn't have OAuth metadata at this path,
 * but might support OAuth via an alternative path or WWW-Authenticate header.
 * - 404: Path not found (most common)
 * - 401: Unauthorized (some servers return this for metadata endpoints)
 * - 406: Not Acceptable (Grain returns this when MCP endpoints don't support .well-known paths)
 */
const NO_METADATA_STATUSES = [404, 401, 406];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get connection URL from storage by connection ID, optionally scoped to an
 * organization. Connection IDs are globally unique, but callers that have an
 * org slug in scope should pass `organizationId` so cross-org lookups return
 * null instead of a connection from another org.
 */
async function getConnectionUrl(
  connectionId: string,
  ctx: MeshContext,
  organizationId?: string,
): Promise<string | null> {
  const connection = await ctx.storage.connections.findById(
    connectionId,
    organizationId,
  );
  return connection?.connection_url ?? null;
}

/**
 * Check if origin MCP server supports OAuth by looking for WWW-Authenticate header on 401 response.
 * This is useful for servers that support OAuth but don't implement RFC 9728 Protected Resource Metadata.
 * Returns the WWW-Authenticate header value if OAuth is supported, null otherwise.
 */
function looksLikeOAuthWwwAuthenticate(wwwAuth: string): boolean {
  const wwwAuthLower = wwwAuth.toLowerCase();
  // MCP OAuth uses RFC 9728 `resource_metadata=...` (strong signal)
  // Some servers may not implement RFC 9728 but still include standard OAuth error hints.
  return (
    wwwAuthLower.includes("resource_metadata=") ||
    wwwAuthLower.includes("invalid_token") ||
    wwwAuthLower.includes("oauth")
  );
}

async function checkOriginSupportsOAuth(
  connectionUrl: string,
  headers: Record<string, string> = {},
): Promise<string | null> {
  try {
    const response = await fetch(connectionUrl, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcp-cms-proxy", version: "1.0.0" },
        },
      }),
    });

    // If we get a 401 with WWW-Authenticate, the server supports OAuth
    if (response.status === 401) {
      const wwwAuth = response.headers.get("WWW-Authenticate");
      if (wwwAuth) {
        if (looksLikeOAuthWwwAuthenticate(wwwAuth)) {
          return wwwAuth;
        }
      }

      // Fallback: Check if server has OAuth metadata endpoints even without WWW-Authenticate.
      // Some servers like ClickHouse support OAuth but don't include WWW-Authenticate header.
      const hasOAuthMetadata = await checkHasOAuthMetadata(connectionUrl);
      if (hasOAuthMetadata) {
        // Return a synthetic WWW-Authenticate value to indicate OAuth is supported
        return 'Bearer realm="mcp"';
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if origin server has OAuth metadata endpoints available.
 * This is a fallback for servers that support OAuth but don't include WWW-Authenticate header.
 */
async function checkHasOAuthMetadata(connectionUrl: string): Promise<boolean> {
  try {
    const connUrl = new URL(connectionUrl);

    // Try authorization server metadata at origin root first (most common)
    const authServerUrl = new URL(
      "/.well-known/oauth-authorization-server",
      connUrl.origin,
    );
    const authServerRes = await fetch(authServerUrl.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (authServerRes.ok) {
      const data = (await authServerRes.json()) as Record<string, unknown>;
      // Verify it looks like valid authorization server metadata
      if (data.authorization_endpoint || data.token_endpoint || data.issuer) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Fetch protected resource metadata, trying both well-known URL formats
 * Format 1: {resource}/.well-known/oauth-protected-resource (resource-relative)
 * Format 2: /.well-known/oauth-protected-resource{resource-path} (well-known prefix, e.g. Smithery)
 *
 * Per RFC 9728: strip trailing slash before inserting /.well-known/
 * Returns the response (even if error) so caller can handle/pass-through error status
 */
export async function fetchProtectedResourceMetadata(
  connectionUrl: string,
): Promise<Response> {
  const connUrl = new URL(connectionUrl);
  // Normalize: strip trailing slash per RFC 9728
  let resourcePath = connUrl.pathname;
  if (resourcePath.endsWith("/")) {
    resourcePath = resourcePath.slice(0, -1);
  }

  // Try format 1 first (most common)
  const format1Url = new URL(connectionUrl);
  format1Url.pathname = `${resourcePath}/.well-known/oauth-protected-resource`;

  let response = await fetch(format1Url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (response.ok) return response;

  // If format 1 returns a "no metadata" status, try format 2 (Smithery-style: well-known prefix)
  // For other errors (500, etc.), return immediately to preserve error info
  if (!NO_METADATA_STATUSES.includes(response.status)) return response;

  const format2Url = new URL(connectionUrl);
  format2Url.pathname = `/.well-known/oauth-protected-resource${resourcePath}`;

  response = await fetch(format2Url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!NO_METADATA_STATUSES.includes(response.status)) return response;

  const format3Url = new URL(connectionUrl);
  format3Url.pathname = `/.well-known/oauth-protected-resource`;

  response = await fetch(format3Url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  return response;
}

/**
 * Get the origin authorization server URL from connection's protected resource metadata.
 * Falls back to the origin server's root if Protected Resource Metadata doesn't exist,
 * since many servers (like Apify) expose /.well-known/oauth-authorization-server at the root.
 */
async function getOriginAuthServer(
  connectionUrl: string,
): Promise<string | null> {
  // Parse URL upfront - if invalid, bail early
  let origin: string;
  try {
    origin = new URL(connectionUrl).origin;
  } catch {
    return null;
  }

  try {
    const response = await fetchProtectedResourceMetadata(connectionUrl);
    if (response.ok) {
      const data = (await response.json()) as {
        authorization_servers?: string[];
      };
      if (data.authorization_servers?.[0]) {
        return data.authorization_servers[0];
      }
    }
  } catch {
    // Fetch failed, fall through to origin fallback
  }

  // Fall back to origin's root if Protected Resource Metadata doesn't exist
  // or doesn't have authorization_servers. Many servers (like Apify) expose
  // auth server metadata at the root.
  return origin;
}

/**
 * Ensure MeshContext is available, creating it if necessary
 */
async function ensureContext(c: {
  req: { raw: Request };
  get: (key: "meshContext") => MeshContext | undefined;
  set: (key: "meshContext", value: MeshContext) => void;
}): Promise<MeshContext> {
  let ctx = c.get("meshContext");
  if (!ctx) {
    ctx = await ContextFactory.create(c.req.raw);
    c.set("meshContext", ctx);
  }
  return ctx;
}

// ============================================================================
// Protected Resource Metadata Proxy
// ============================================================================

export interface HandleAuthErrorOptions {
  /** The error from the MCP client connection attempt */
  error: Error & { status?: number; code?: number };
  /** The request URL (used to build the OAuth proxy URL) */
  reqUrl: URL;
  /** The connection ID */
  connectionId: string;
  /** The origin MCP server URL */
  connectionUrl: string;
  /** Headers to use when checking the origin server */
  headers: Record<string, string>;
  /**
   * Optional org slug. When set, the WWW-Authenticate `resource_metadata`
   * URL is built under `/api/:orgSlug/mcp/...` instead of the legacy
   * `/mcp/...`. Set this when the request was served via the new
   * `/api/:org/mcp/...` mount so OAuth clients discover the correct
   * metadata URL.
   */
  orgSlug?: string;
}

/**
 * Build the URL prefix for OAuth-related URLs based on org slug.
 * - With slug: `/api/${slug}` (new path shape)
 * - Without slug: `` (legacy path shape — `/mcp/...` and `/oauth-proxy/...`
 *   live at the root)
 */
function buildPathPrefix(orgSlug: string | undefined): string {
  return orgSlug ? `/api/${orgSlug}` : "";
}

/**
 * Handles 401 auth errors from MCP origin servers.
 *
 * Checks if the origin server supports OAuth by looking for WWW-Authenticate header.
 * - If origin supports OAuth: returns 401 with WWW-Authenticate pointing to our proxy
 * - If origin doesn't support OAuth: returns plain 401 with JSON error
 * - If not an auth error: returns null (caller should handle)
 */
export async function handleAuthError({
  error,
  reqUrl,
  connectionId,
  connectionUrl,
  headers,
  orgSlug,
}: HandleAuthErrorOptions): Promise<Response | null> {
  const message = error.message?.toLowerCase() ?? "";
  const isAuthError =
    error.status === 401 ||
    error.code === 401 ||
    error.message?.includes("401") ||
    message.includes("unauthorized") ||
    message.includes("invalid_token") ||
    message.includes("api key required") ||
    message.includes("api-key required");

  if (!isAuthError) {
    return null;
  }

  // Check if origin supports OAuth by looking for a *meaningful* WWW-Authenticate challenge.
  // Some servers require a Bearer token (PAT/API key) and include WWW-Authenticate without being OAuth-capable.
  const originSupportsOAuth = Boolean(
    await checkOriginSupportsOAuth(connectionUrl, headers),
  );

  if (originSupportsOAuth) {
    const prefix = buildPathPrefix(orgSlug);
    return new Response(null, {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="mcp",resource_metadata="${reqUrl.origin}${prefix}/mcp/${connectionId}/.well-known/oauth-protected-resource"`,
      },
    });
  }

  return new Response(
    JSON.stringify({
      error: "unauthorized",
      message: "Authentication required but server does not support OAuth",
    }),
    {
      status: 401,
      headers: { "Content-Type": "application/json" },
    },
  );
}

const fixProtocol = (url: URL) => {
  const isLocal =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1";
  if (!isLocal) {
    url.protocol = "https:";
  }
  return url;
};

/**
 * Handler for proxying OAuth protected resource metadata
 * Rewrites resource to /mcp/:connectionId and authorization_servers to /oauth-proxy/:connectionId
 *
 * For servers that don't implement RFC 9728 Protected Resource Metadata but still support OAuth
 * (detectable via WWW-Authenticate header on 401), we generate synthetic metadata that points
 * to our OAuth proxy. This enables OAuth flows for servers like Apify that use WWW-Authenticate
 * but don't expose .well-known/oauth-protected-resource.
 */
export const protectedResourceMetadataHandler = async (c: {
  req: {
    param: ((key: "connectionId") => string) &
      ((key: "org") => string | undefined);
    raw: Request;
    url: string;
  };
  get: (key: "meshContext") => MeshContext | undefined;
  set: (key: "meshContext", value: MeshContext) => void;
  json: (data: unknown, status?: number) => Response;
}) => {
  const connectionId = c.req.param("connectionId");
  const ctx = await ensureContext(c);

  const requestUrl = fixProtocol(new URL(c.req.url));
  // Org slug sources (in priority order):
  // 1. `c.req.param("org")` — present on the top-level well-known prefix
  //    route `/.well-known/oauth-protected-resource/api/:org/mcp/:id` and
  //    on the `/api/:org`-mounted variant. The path slug is the source of
  //    truth: the URL literally names which org's connection the SDK is
  //    asking metadata for. The path-mounted variant lives outside the
  //    sub-app so `resolveOrgFromPath` never runs there — without honoring
  //    the path param first, `ctx.organization` falls back to the session's
  //    `activeOrganizationId`, and multi-org users hitting another org's URL
  //    silently lookup against their active org and 404.
  // 2. `ctx.organization?.slug` — set by `resolveOrgFromPath` for routes
  //    inside the `/api/:org` sub-app, or by the meshContext factory from
  //    the session's active org. Used only when the path doesn't carry a
  //    slug (legacy `/mcp/:id/.well-known/...` mount).
  // 3. undefined — legacy routes have no slug; the prefix is empty and
  //    we issue legacy-shape metadata URLs.
  const orgSlug = c.req.param("org") ?? ctx.organization?.slug;

  // When :org is in scope, the connection MUST belong to that org. Resolve
  // the slug to an org id so the connection lookup filters on it; otherwise
  // we'd hand back metadata claiming the connection is served at a path it
  // doesn't actually resolve from. `resolveOrgFromPath` already cached the id
  // for the sub-app mount; the top-level well-known prefix route resolves
  // the slug here. Unknown slug or cross-org connection → 404 (we don't
  // distinguish, to avoid leaking which slugs exist).
  let scopedOrgId: string | undefined;
  if (orgSlug) {
    if (ctx.organization?.id && ctx.organization.slug === orgSlug) {
      scopedOrgId = ctx.organization.id;
    } else {
      const org = await ctx.db
        .selectFrom("organization")
        .select("id")
        .where("slug", "=", orgSlug)
        .executeTakeFirst();
      if (!org) {
        return c.json({ error: "Connection not found" }, 404);
      }
      scopedOrgId = org.id;
    }
  }

  const connectionUrl = await getConnectionUrl(connectionId, ctx, scopedOrgId);
  if (!connectionUrl) {
    return c.json({ error: "Connection not found" }, 404);
  }

  const prefix = buildPathPrefix(orgSlug);
  const proxyResourceUrl = `${requestUrl.origin}${prefix}/mcp/${connectionId}`;
  // Auth-server URL (the value advertised in `authorization_servers`) stays on
  // the legacy `/oauth-proxy/:connectionId` path regardless of the resource
  // path family. The well-known auth-server metadata route
  // (`createWellKnownAuthServerRoutes`) only exists at the legacy URL, and
  // moving it to `/api/:org/...` would land the SDK on Better Auth's catch-all
  // metadata handler (which returns Better Auth's own MCP gateway endpoints)
  // and break DCR with `invalid_client`. The OAuth endpoint URLs *inside*
  // that metadata document (authorize/token/register) are emitted under the
  // org-scoped mount by `authServerMetadataHandler` so they benefit from
  // `resolveOrgFromPath` membership enforcement.
  const proxyAuthServer = `${requestUrl.origin}/oauth-proxy/${connectionId}`;

  try {
    // Fetch from origin, trying both well-known URL formats
    const response = await fetchProtectedResourceMetadata(connectionUrl);

    // If origin returns a "no metadata" status, check if it still supports OAuth via WWW-Authenticate
    // Many servers (like Apify, Grain) support OAuth but don't implement RFC 9728 metadata
    if (!response.ok && NO_METADATA_STATUSES.includes(response.status)) {
      const wwwAuth = await checkOriginSupportsOAuth(connectionUrl);
      if (wwwAuth) {
        // Server supports OAuth but doesn't have metadata endpoint
        // Generate synthetic metadata pointing to our proxy
        const syntheticData = {
          resource: proxyResourceUrl,
          authorization_servers: [proxyAuthServer],
          // Standard fields per RFC 9728
          bearer_methods_supported: ["header"],
          scopes_supported: ["*"],
        };

        return new Response(JSON.stringify(syntheticData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Server doesn't support OAuth at all - pass through the error
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: { "Content-Type": "application/json" },
      });
    }

    // For other non-OK responses, pass through the error
    if (!response.ok) {
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse the response and rewrite URLs to point to our proxy
    const data = (await response.json()) as Record<string, unknown>;

    // Detect if origin returned Authorization Server Metadata (RFC 8414) instead of
    // Protected Resource Metadata (RFC 9728). Some servers like ClickHouse incorrectly
    // return auth server metadata at the protected resource endpoint.
    // Auth server metadata has 'issuer' but not 'resource', while protected resource
    // metadata should have 'resource'.
    const isAuthServerMetadata =
      "issuer" in data &&
      !("resource" in data) &&
      ("authorization_endpoint" in data || "token_endpoint" in data);

    if (isAuthServerMetadata) {
      // Server returned auth server metadata instead of protected resource metadata.
      // Generate clean synthetic protected resource metadata that points to our proxy.
      // We don't spread the original data to avoid polluting the response with
      // unexpected fields that could confuse MCP SDK clients.
      const syntheticData = {
        resource: proxyResourceUrl,
        authorization_servers: [proxyAuthServer],
        bearer_methods_supported: ["header"],
        scopes_supported:
          "scopes_supported" in data &&
          Array.isArray(data.scopes_supported) &&
          data.scopes_supported.length > 0
            ? data.scopes_supported
            : ["*"],
      };

      return new Response(JSON.stringify(syntheticData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Origin returned proper protected resource metadata - rewrite URLs to our proxy
    const rewrittenData = {
      ...data,
      resource: proxyResourceUrl,
      authorization_servers: [proxyAuthServer],
    };

    return new Response(JSON.stringify(rewrittenData), {
      status: response.status,
      statusText: response.statusText,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    const err = error as Error;
    console.error(
      "[oauth-proxy] Failed to proxy OAuth protected resource metadata:",
      err,
    );
    return c.json(
      { error: "Failed to proxy OAuth metadata", message: err.message },
      502,
    );
  }
};

/**
 * Legacy `.well-known/oauth-protected-resource` routes for the pre-org-scoped
 * server URL shape (`/mcp/:id`). Mounted at the URL root with a deprecation
 * log; will be removed once the deprecation window closes.
 *
 * Two URL shapes are served (both probed by MCP clients in the wild):
 *  1. `/.well-known/oauth-protected-resource/mcp/:connectionId` — RFC 9728
 *     Format 2 (well-known prefix), what `@modelcontextprotocol/sdk` probes.
 *  2. `/mcp/:connectionId/.well-known/oauth-protected-resource` — RFC 9728
 *     Format 1 (resource-relative), what the proxy's WWW-Authenticate
 *     `resource_metadata` header points to.
 */
export const createLegacyWellKnownProtectedResourceRoutes = () => {
  const app = new Hono<HonoEnv>();
  app.get("/.well-known/oauth-protected-resource/mcp/:connectionId", (c) =>
    protectedResourceMetadataHandler(c),
  );
  app.get("/mcp/:connectionId/.well-known/oauth-protected-resource", (c) =>
    protectedResourceMetadataHandler(c),
  );
  return app;
};

/**
 * Org-scoped resource-relative `.well-known/oauth-protected-resource` route.
 * Mounted inside the `/api/:org` sub-app; expands to
 * `/api/:org/mcp/:connectionId/.well-known/oauth-protected-resource`. This is
 * the URL the proxy's WWW-Authenticate `resource_metadata` points to under
 * the new path family — `resolveOrgFromPath` runs first, so the handler picks
 * up `ctx.organization?.slug` directly.
 *
 * The well-known *prefix* shape for org-scoped server URLs
 * (`/.well-known/oauth-protected-resource/api/:org/mcp/:connectionId`) is
 * registered separately at the URL root in `app.ts` — RFC 9728 Format 2
 * anchors the well-known prefix at the origin, so it must live outside any
 * `/api/:org` sub-app.
 */
export const createOrgScopedWellKnownProtectedResourceRoutes = () => {
  const app = new Hono<HonoEnv>();
  app.get("/mcp/:connectionId/.well-known/oauth-protected-resource", (c) =>
    protectedResourceMetadataHandler(c),
  );
  return app;
};

// ============================================================================
// Authorization Server Metadata Proxy
// ============================================================================

/**
 * Fetch authorization server metadata, trying multiple well-known URL formats per spec.
 *
 * For issuer URLs with path components (e.g., https://auth.example.com/tenant1):
 * 1. OAuth 2.0 Authorization Server Metadata with path insertion:
 *    https://auth.example.com/.well-known/oauth-authorization-server/tenant1
 * 2. OpenID Connect 1.0 Discovery with path insertion:
 *    https://auth.example.com/.well-known/openid-configuration/tenant1
 * 3. OpenID Connect 1.0 Discovery with path append:
 *    https://auth.example.com/tenant1/.well-known/openid-configuration
 *
 * For issuer URLs without path components (e.g., https://auth.example.com):
 * 1. OAuth 2.0 Authorization Server Metadata:
 *    https://auth.example.com/.well-known/oauth-authorization-server
 * 2. OpenID Connect 1.0 Discovery:
 *    https://auth.example.com/.well-known/openid-configuration
 *
 * Returns the response (even if error) so caller can handle/pass-through error status
 */
export async function fetchAuthorizationServerMetadata(
  authServerUrl: string,
): Promise<Response> {
  const url = new URL(authServerUrl);
  // Normalize: strip trailing slash
  let authServerPath = url.pathname;
  if (authServerPath.endsWith("/")) {
    authServerPath = authServerPath.slice(0, -1);
  }

  // Check if URL has a path component
  const hasPath = authServerPath !== "" && authServerPath !== "/";

  // Build list of URLs to try in priority order
  const urlsToTry: URL[] = [];

  if (hasPath) {
    // Format 1: OAuth 2.0 with path insertion
    const format1 = new URL(authServerUrl);
    format1.pathname = `/.well-known/oauth-authorization-server${authServerPath}`;
    urlsToTry.push(format1);

    // Format 2: OpenID Connect with path insertion
    const format2 = new URL(authServerUrl);
    format2.pathname = `/.well-known/openid-configuration${authServerPath}`;
    urlsToTry.push(format2);

    // Format 3: OpenID Connect with path append
    const format3 = new URL(authServerUrl);
    format3.pathname = `${authServerPath}/.well-known/openid-configuration`;
    urlsToTry.push(format3);
  } else {
    // Format 1: OAuth 2.0 at root
    const format1 = new URL(authServerUrl);
    format1.pathname = "/.well-known/oauth-authorization-server";
    urlsToTry.push(format1);

    // Format 2: OpenID Connect at root
    const format2 = new URL(authServerUrl);
    format2.pathname = "/.well-known/openid-configuration";
    urlsToTry.push(format2);
  }

  // Try each URL in order
  let response: Response | null = null;
  for (const tryUrl of urlsToTry) {
    response = await fetch(tryUrl.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    // If successful, return immediately
    if (response.ok) return response;

    // For 404/401, try next format
    // For other errors (500, etc.), return immediately to preserve error info
    if (response.status !== 404 && response.status !== 401) {
      return response;
    }
  }

  // Return the last response (will be an error)
  return response!;
}

/**
 * Proxy authorization server metadata to avoid CORS issues
 * Rewrites OAuth endpoint URLs to go through our proxy
 */
const authServerMetadataHandler = async (c: {
  req: { param: (key: string) => string; raw: Request; url: string };
  get: (key: "meshContext") => MeshContext | undefined;
  set: (key: "meshContext", value: MeshContext) => void;
  json: (data: unknown, status?: number) => Response;
}) => {
  const connectionId = c.req.param("connectionId");
  const ctx = await ensureContext(c);

  // Fetch the connection (unscoped — connection IDs are globally unique) so we
  // can derive both the origin auth server and the owning org slug for
  // org-scoped endpoint URLs.
  const connection = await ctx.storage.connections.findById(connectionId);
  if (!connection?.connection_url) {
    return c.json({ error: "Connection not found or no auth server" }, 404);
  }

  const originAuthServer = await getOriginAuthServer(connection.connection_url);
  if (!originAuthServer) {
    return c.json({ error: "Connection not found or no auth server" }, 404);
  }

  // Look up the connection's owning org slug. The endpoints inside this
  // metadata document route through the canonical `/api/:org/oauth-proxy/...`
  // mount — `resolveOrgFromPath` runs there and enforces cross-org access via
  // membership. The legacy `/oauth-proxy/:connectionId/*` mount can't tell the
  // path-resolved org apart from the session's `activeOrganizationId` and
  // silently 404s multi-org users on DCR (`POST /register`).
  const org = await ctx.db
    .selectFrom("organization")
    .select("slug")
    .where("id", "=", connection.organization_id)
    .executeTakeFirst();

  try {
    // Fetch auth server metadata, trying all well-known URL formats
    const response = await fetchAuthorizationServerMetadata(originAuthServer);

    if (!response.ok) {
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse and rewrite URLs to point to our proxy
    const data = (await response.json()) as Record<string, unknown>;
    const requestUrl = fixProtocol(new URL(c.req.url));
    // The AS metadata route itself stays at the legacy global path
    // (`/.well-known/oauth-authorization-server/oauth-proxy/:connectionId`)
    // because the SDK derives it from the `authorization_servers` value in the
    // protected-resource metadata, which we keep legacy for cache stability
    // and to avoid landing on Better Auth's catch-all metadata handler.
    // The endpoint URLs *inside* this metadata, however, move to the canonical
    // org-scoped mount so DCR/token/authorize benefit from `resolveOrgFromPath`
    // membership enforcement. Connections without a resolvable org slug
    // (orphaned data) fall back to the legacy proxy path.
    const proxyBase = org?.slug
      ? `${requestUrl.origin}/api/${org.slug}/oauth-proxy/${connectionId}`
      : `${requestUrl.origin}/oauth-proxy/${connectionId}`;

    // Rewrite OAuth endpoint URLs to go through our proxy
    const rewrittenData = {
      ...data,
      authorization_endpoint: data.authorization_endpoint
        ? `${proxyBase}/authorize`
        : undefined,
      token_endpoint: data.token_endpoint ? `${proxyBase}/token` : undefined,
      registration_endpoint: data.registration_endpoint
        ? `${proxyBase}/register`
        : undefined,
    };

    return new Response(JSON.stringify(rewrittenData), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    const err = error as Error;
    console.error("[oauth-proxy] Failed to proxy auth server metadata:", err);
    return c.json(
      { error: "Failed to proxy auth server metadata", message: err.message },
      502,
    );
  }
};

/**
 * Factory for the auth-server metadata route. This stays at the legacy
 * RFC-mandated path `/.well-known/oauth-authorization-server/oauth-proxy/:connectionId`
 * — third-party OAuth providers may have this URL registered as a
 * redirect_uri base, so we keep it global indefinitely.
 */
export const createWellKnownAuthServerRoutes = () => {
  const app = new Hono<HonoEnv>();
  app.get(
    "/.well-known/oauth-authorization-server/oauth-proxy/:connectionId",
    authServerMetadataHandler,
  );
  return app;
};

// Note: The /oauth-proxy/:connectionId/:endpoint route is defined directly in app.ts
// because app.route() doesn't properly register routes with dynamic segments at root level

/**
 * Default export: a Hono app that mounts every route in this file.
 *
 * Kept for backward compatibility with `oauth-proxy.test.ts` (which mounts
 * the whole module under `/`) and as an escape hatch for any other caller
 * that wants the full surface in one go. Production code (`app.ts`) uses
 * the individual factories so it can apply `logDeprecatedRoute` to the
 * legacy mounts and dual-mount under `/api/:org/...`.
 */
const app = new Hono<HonoEnv>();
app.route("/", createLegacyWellKnownProtectedResourceRoutes());
app.route("/", createWellKnownAuthServerRoutes());
export default app;
