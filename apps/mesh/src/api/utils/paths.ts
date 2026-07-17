/**
 * Path utility functions for routing decisions
 *
 * These functions help determine how to handle different types of paths
 * (API routes, static files, system endpoints, etc.)
 */

/** System paths that don't require authentication or special handling */
export const SYSTEM_PATHS = {
  // Bare /health is the AWS NLB target-group health-check path. Kept distinct
  // from the K8s liveness/readiness probes so the load balancer can pull a
  // draining pod on its own during rollout.
  HEALTH: "/health",
  HEALTH_LIVE: "/health/live",
  HEALTH_READY: "/health/ready",
  METRICS: "/metrics",
  // Cluster-internal only: no Service/Gateway routes to it (worker pods have
  // neither), so it only answers on the pod's own port — for a KEDA
  // metrics-api trigger or similar in-cluster poller.
  DBOS_QUEUE_DEPTH_PREFIX: "/dbos-queue-depth/",
  // Cluster-internal only (same as DBOS_QUEUE_DEPTH_PREFIX): parked-run backlog
  // for a KEDA metrics-api trigger. The queue-depth endpoint counts ENQUEUED
  // only, but the gate parks DEQUEUED (PENDING) runs — so this is the signal
  // that reflects a saturated pod.
  HOSTED_RUN_PENDING: "/hosted-run-pending",
} as const;

/** Path prefixes for different route types (internal use only) */
const PATH_PREFIXES = {
  API: "/api/",
  API_AUTH: "/api/auth/",
  MCP: "/mcp/",
  OAUTH_PROXY: "/oauth-proxy/",
  WELL_KNOWN: "/.well-known",
  ORG: "/org/",
  REPORT: "/report/",
} as const;

/** Static file extensions that should be served as-is (internal use only) */
const STATIC_FILE_PATTERN =
  /\.(html|css|js|ico|svg|png|jpg|jpeg|gif|webp|woff|woff2)$/;

export function isHealthPath(path: string): boolean {
  return (
    path === SYSTEM_PATHS.HEALTH ||
    path === SYSTEM_PATHS.HEALTH_LIVE ||
    path === SYSTEM_PATHS.HEALTH_READY
  );
}

/** Check if a path is a system endpoint (health, metrics, well-known) */
function isSystemPath(path: string): boolean {
  return (
    path === SYSTEM_PATHS.HEALTH ||
    path === SYSTEM_PATHS.HEALTH_LIVE ||
    path === SYSTEM_PATHS.HEALTH_READY ||
    path === SYSTEM_PATHS.METRICS ||
    path.startsWith(PATH_PREFIXES.WELL_KNOWN) ||
    path.startsWith(SYSTEM_PATHS.DBOS_QUEUE_DEPTH_PREFIX) ||
    path === SYSTEM_PATHS.HOSTED_RUN_PENDING
  );
}

/** Check if a path is an API route */
function isApiPath(path: string): boolean {
  return path.startsWith(PATH_PREFIXES.API);
}

/**
 * Check if a path should be handled by the API server (Hono routes)
 * Returns true for API routes, MCP routes, OAuth proxy routes, org routes, and system endpoints
 */
export function isServerPath(path: string): boolean {
  return (
    isApiPath(path) ||
    path === "/mcp" ||
    path.startsWith(PATH_PREFIXES.MCP) ||
    path.startsWith(PATH_PREFIXES.OAUTH_PROXY) ||
    path.startsWith(PATH_PREFIXES.ORG) ||
    path.startsWith(PATH_PREFIXES.REPORT) ||
    isSystemPath(path)
  );
}

/**
 * Check if a path should skip StudioContext injection
 * Used in the context middleware to avoid creating contexts for
 * paths that don't need database access
 */
export function shouldSkipStudioContext(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith(PATH_PREFIXES.API_AUTH) ||
    path === "/api/trigger-callback" ||
    isSystemPath(path) ||
    // Static file extension check only applies to non-API paths (e.g. Vite assets).
    // API paths like /api/:org/files/image.jpeg still need StudioContext for auth.
    (!isApiPath(path) && STATIC_FILE_PATTERN.test(path))
  );
}
