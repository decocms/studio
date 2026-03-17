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

const app = new Hono<HonoEnv>();

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
 * Get connection URL from storage by connection ID
 * Does not require organization ID - connections are globally unique
 */
async function getConnectionUrl(
  connectionId: string,
  ctx: MeshContext,
): Promise<string | null> {
  const connection = await ctx.storage.connections.findById(connectionId);
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
  connectionId: string,
  ctx: MeshContext,
): Promise<string | null> {
  const connectionUrl = await getConnectionUrl(connectionId, ctx);
  if (!connectionUrl) return null;

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
    return new Response(null, {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="mcp",resource_metadata="${reqUrl.origin}/mcp/${connectionId}/.well-known/oauth-protected-resource"`,
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
const protectedResourceMetadataHandler = async (c: {
  req: { param: (key: string) => string; raw: Request; url: string };
  get: (key: "meshContext") => MeshContext | undefined;
  set: (key: "meshContext", value: MeshContext) => void;
  json: (data: unknown, status?: number) => Response;
}) => {
  const connectionId = c.req.param("connectionId");
  const ctx = await ensureContext(c);

  const connectionUrl = await getConnectionUrl(connectionId, ctx);
  if (!connectionUrl) {
    return c.json({ error: "Connection not found" }, 404);
  }

  const requestUrl = fixProtocol(new URL(c.req.url));
  const proxyResourceUrl = `${requestUrl.origin}/mcp/${connectionId}`;
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

// Route 1: /.well-known/oauth-protected-resource/mcp/:connectionId
app.get("/.well-known/oauth-protected-resource/mcp/:connectionId", (c) =>
  protectedResourceMetadataHandler(c),
);

// Route 2: /mcp/:connectionId/.well-known/oauth-protected-resource
app.get("/mcp/:connectionId/.well-known/oauth-protected-resource", (c) =>
  protectedResourceMetadataHandler(c),
);

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
app.get(
  "/.well-known/oauth-authorization-server/oauth-proxy/:connectionId",
  async (c) => {
    const connectionId = c.req.param("connectionId");
    const ctx = await ensureContext(c);

    const originAuthServer = await getOriginAuthServer(connectionId, ctx);
    if (!originAuthServer) {
      return c.json({ error: "Connection not found or no auth server" }, 404);
    }

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
      const proxyBase = `${requestUrl.origin}/oauth-proxy/${connectionId}`;

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
  },
);

// Note: The /oauth-proxy/:connectionId/:endpoint route is defined directly in app.ts
// because app.route() doesn't properly register routes with dynamic segments at root level

export default app;
