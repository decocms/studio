/**
 * Server Constants
 *
 * Centralized configuration for server-related constants.
 * Respects BASE_URL, PORT, and MESH_HOME environment variables.
 */

import { homedir } from "os";
import { join } from "path";

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
 * Get the Mesh home directory for data storage.
 *
 * Priority:
 * 1. MESH_HOME environment variable (if set)
 * 2. ~/deco/
 *
 * This is the default location for:
 * - Database (mesh.db)
 * - Secrets (secrets.json)
 * - Local assets (assets/)
 */
export function getMeshHome(): string {
  return process.env.MESH_HOME || join(homedir(), "deco");
}
