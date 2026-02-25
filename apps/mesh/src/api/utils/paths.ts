/**
 * Path utility functions for routing decisions
 *
 * These functions help determine how to handle different types of paths
 * (API routes, static files, system endpoints, etc.)
 */

/** System paths that don't require authentication or special handling */
export const SYSTEM_PATHS = {
  HEALTH: "/health",
  METRICS: "/metrics",
} as const;

/** Path prefixes for different route types (internal use only) */
const PATH_PREFIXES = {
  API: "/api/",
  API_AUTH: "/api/auth/",
  MCP: "/mcp/",
  OAUTH_PROXY: "/oauth-proxy/",
  WELL_KNOWN: "/.well-known",
  ORG: "/org/",
} as const;

/** Static file extensions that should be served as-is (internal use only) */
const STATIC_FILE_PATTERN =
  /\.(html|css|js|ico|svg|png|jpg|jpeg|gif|webp|woff|woff2)$/;

/** Check if a path is a system endpoint (health, metrics, well-known) */
function isSystemPath(path: string): boolean {
  return (
    path === SYSTEM_PATHS.HEALTH ||
    path === SYSTEM_PATHS.METRICS ||
    path.startsWith(PATH_PREFIXES.WELL_KNOWN)
  );
}

/** Check if a path is an API route */
function isApiPath(path: string): boolean {
  return path.startsWith(PATH_PREFIXES.API);
}

/** Check if a path is an MCP route */
function isMcpPath(path: string): boolean {
  // Match both /mcp (exact) and /mcp/* (prefix)
  return path === "/mcp" || path.startsWith(PATH_PREFIXES.MCP);
}

/** Check if a path is an OAuth proxy route */
function isOAuthProxyPath(path: string): boolean {
  return path.startsWith(PATH_PREFIXES.OAUTH_PROXY);
}

/** Check if a path is a static file based on extension */
function isStaticFilePath(path: string): boolean {
  return STATIC_FILE_PATTERN.test(path);
}

/** Check if a path is an organization route */
function isOrgPath(path: string): boolean {
  return path.startsWith(PATH_PREFIXES.ORG);
}

/**
 * Check if a path should be handled by the API server (Hono routes)
 * Returns true for API routes, MCP routes, OAuth proxy routes, org routes, and system endpoints
 */
export function isServerPath(path: string): boolean {
  return (
    isApiPath(path) ||
    isMcpPath(path) ||
    isOAuthProxyPath(path) ||
    isOrgPath(path) ||
    isSystemPath(path)
  );
}

/**
 * Check if a path should skip MeshContext injection
 * Used in the context middleware to avoid creating contexts for
 * paths that don't need database access
 */
export function shouldSkipMeshContext(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith(PATH_PREFIXES.API_AUTH) ||
    path.startsWith("/api/cli/") ||
    isSystemPath(path) ||
    isStaticFilePath(path)
  );
}
