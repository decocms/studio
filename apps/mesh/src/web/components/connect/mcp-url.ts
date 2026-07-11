/**
 * Shared helpers for building this org's unified MCP endpoint URL and the
 * one-line `claude mcp add` command. Kept in one place so the topbar "LINK"
 * dialog and the full Connect settings page can't drift apart.
 */

/** MCP server name registered in the client's config (e.g. `studio`). */
const CONNECT_SERVER_NAME = "studio";

/** The org-scoped unified MCP endpoint: `<origin>/api/<slug>/mcp`. */
export function mcpUrl(orgSlug: string): string {
  const origin =
    typeof window === "undefined"
      ? "http://localhost:3000"
      : window.location.origin;
  return `${origin}/api/${orgSlug}/mcp`;
}

/**
 * One-liner that adds this org to Claude Code with a pre-minted bearer token
 * baked in as an `Authorization` header. Unlike the OAuth variant this needs
 * NO `/mcp` step and NO browser login — Claude Code sends the token on the
 * first request and every tool is live immediately. The token is a real
 * credential, so this command should be treated like a password.
 */
export function claudeCodeCommandWithKey(
  orgSlug: string,
  apiKey: string,
): string {
  return `claude mcp add --transport http --scope user ${CONNECT_SERVER_NAME} ${mcpUrl(orgSlug)} --header "Authorization: Bearer ${apiKey}"`;
}
