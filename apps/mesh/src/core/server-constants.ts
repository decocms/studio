/**
 * Server Constants
 *
 * Centralized configuration for server-related constants.
 * Respects BASE_URL and PORT environment variables.
 */

import { getSettings } from "../settings";

/**
 * Get the base URL for the server.
 *
 * Priority:
 * 1. BASE_URL environment variable (if set)
 * 2. http://localhost:{PORT} where PORT defaults to 3000
 */
export function getBaseUrl(): string {
  const settings = getSettings();
  if (settings.baseUrl) {
    return settings.baseUrl;
  }
  return `http://localhost:${settings.port ?? 3000}`;
}

/**
 * Get the internal loopback URL for server-to-server connections.
 * Always uses localhost:PORT so the server can reach itself
 * even when BASE_URL is a proxy hostname (e.g. tokyo.localhost).
 */
export function getInternalUrl(): string {
  return `http://localhost:${getSettings().port ?? 3000}`;
}

/**
 * Get the cluster's externally reachable URL.
 *
 * Used when minting URLs that need to be resolvable from outside the
 * cluster — e.g. the MCP endpoint URL handed to a remote link daemon
 * (Phase 9 remote harness dispatch), which talks back to the cluster
 * over HTTP from the user's laptop.
 *
 * In dev mode (`MESH_ALLOW_LOCALHOST_LINKS=1`) we deliberately advertise
 * a localhost URL so a link daemon running on the same machine can dial
 * the cluster without a public hostname. Honors
 * `MESH_LOCAL_CLUSTER_URL` to allow per-developer overrides.
 *
 * Otherwise we use `BASE_URL` (the same hostname the server advertises
 * to browsers and OAuth clients). Falls back to `getBaseUrl()` so
 * production deployments without a separate public-URL setting still
 * work.
 */
export function getPublicUrl(): string {
  if (process.env.MESH_ALLOW_LOCALHOST_LINKS === "1") {
    return (
      process.env.MESH_LOCAL_CLUSTER_URL ??
      `http://localhost:${getSettings().port ?? 3000}`
    );
  }
  return process.env.MESH_PUBLIC_URL ?? getBaseUrl();
}
