/**
 * Deco-specific Constants
 *
 * Constants and utilities for Deco-hosted MCPs and integrations.
 */

/** Deco CMS API host for detecting deco-hosted MCPs */
export const DECO_CMS_API_HOST = "api.decocms.com";

/** The Deco Store registry URL (public, no OAuth) */
export const DECO_STORE_URL = "https://api.decocms.com/mcp/registry";

/** OpenRouter MCP URL (deco-hosted) */
export const OPENROUTER_MCP_URL = "https://sites-openrouter.decocache.com/mcp";

/** OpenRouter icon URL */
export const OPENROUTER_ICON_URL =
  "https://assets.decocache.com/decocms/b2e2f64f-6025-45f7-9e8c-3b3ebdd073d8/openrouter_logojpg.jpg";

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
