/**
 * Deco-specific Constants
 *
 * Constants and utilities for Deco-hosted MCPs and integrations.
 */

/** Deco CMS API host for detecting deco-hosted MCPs */
export const DECO_CMS_API_HOST = "api.decocms.com";

/** The Deco Store registry URL (public, no OAuth) */
export const DECO_STORE_URL =
  "https://studio.decocms.com/org/deco/registry/mcp";

/**
 * Check if a connection URL is a deco-hosted MCP (excluding the registry itself).
 * Used to determine if smart OAuth params should be added.
 */
export function isDecoHostedMcp(connectionUrl: string | null): boolean {
  if (!connectionUrl) return false;
  try {
    const url = new URL(connectionUrl);
    return url.host === DECO_CMS_API_HOST && connectionUrl !== DECO_STORE_URL;
  } catch {
    return false;
  }
}
