/**
 * Server Constants
 *
 * Centralized configuration for server-related constants.
 * Respects BASE_URL and PORT environment variables.
 */

/**
 * Get the base URL for the server.
 *
 * Priority:
 * 1. BASE_URL environment variable (if set)
 * 2. http://localhost:{PORT} where PORT defaults to 3000
 */
export function getBaseUrl(): string {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL;
  }
  const port = process.env.PORT || "3000";
  return `http://localhost:${port}`;
}

/**
 * Get the internal loopback URL for server-to-server connections.
 * Always uses localhost:PORT so the server can reach itself
 * even when BASE_URL is a proxy hostname (e.g. tokyo.localhost).
 */
export function getInternalUrl(): string {
  const port = process.env.PORT || "3000";
  return `http://localhost:${port}`;
}
