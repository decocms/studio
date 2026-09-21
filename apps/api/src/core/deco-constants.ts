/**
 * Deco-specific Constants
 *
 * Constants and utilities for Deco-hosted MCPs and integrations.
 */

/** Deco CMS API host for detecting deco-hosted MCPs */
const DECO_CMS_API_HOST = "api.decocms.com";

/**
 * Check if a connection URL is a deco-hosted MCP.
 * Used to determine if smart OAuth params should be added.
 */
export function isDecoHostedMcp(connectionUrl: string | null): boolean {
  if (!connectionUrl) return false;
  try {
    const url = new URL(connectionUrl);
    return url.host === DECO_CMS_API_HOST;
  } catch {
    return false;
  }
}
