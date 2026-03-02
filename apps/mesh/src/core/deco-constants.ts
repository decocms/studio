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

/** Deco AI Gateway MCP URL (deco-hosted) */
export const DECO_AI_GATEWAY_MCP_URL =
  "https://sites-deco-ai-gateway.decocache.com/mcp";

const AI_GATEWAY_URLS = [DECO_AI_GATEWAY_MCP_URL];

/** Tolerant check: matches the AI Gateway even with trailing slash or query params. */
export function isDecoAIGatewayUrl(
  connectionUrl: string | null | undefined,
): boolean {
  if (!connectionUrl) return false;
  try {
    const url = new URL(connectionUrl);
    return AI_GATEWAY_URLS.some((candidate) => {
      const expected = new URL(candidate);
      return (
        url.host === expected.host &&
        url.pathname.replace(/\/$/, "") === expected.pathname
      );
    });
  } catch {
    return false;
  }
}

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
