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
 * (remote harness dispatch), which talks back to the cluster over the
 * public network from the user's desktop.
 *
 * Uses `MESH_PUBLIC_URL` when set, otherwise falls back to `BASE_URL`
 * (the same hostname the server advertises to browsers and OAuth clients).
 * Falls back to `getBaseUrl()` so production deployments without a
 * separate public-URL setting still work.
 */
export function getPublicUrl(): string {
  return process.env.MESH_PUBLIC_URL ?? getBaseUrl();
}
