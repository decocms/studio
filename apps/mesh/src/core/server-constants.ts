/**
 * Server Constants
 *
 * Centralized configuration for server-related constants.
 * Respects BASE_URL and PORT environment variables.
 */

import { env } from "../env";

/**
 * Get the base URL for the server.
 *
 * Priority:
 * 1. BASE_URL environment variable (if set)
 * 2. http://localhost:{PORT} where PORT defaults to 3000
 */
export function getBaseUrl(): string {
  if (env.BASE_URL) {
    return env.BASE_URL;
  }
  return `http://localhost:${env.PORT}`;
}

/**
 * Get the internal loopback URL for server-to-server connections.
 * Always uses localhost:PORT so the server can reach itself
 * even when BASE_URL is a proxy hostname (e.g. tokyo.localhost).
 */
export function getInternalUrl(): string {
  return `http://localhost:${env.PORT}`;
}
