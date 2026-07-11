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
 * One-liner that adds this org to Claude Code over OAuth. Pasting it into a
 * terminal is the closest thing to a one-click "connect to Claude" — the
 * browser opens on first use to sign in, then every tool in the org is live.
 */
export function claudeCodeCommand(orgSlug: string): string {
  return `claude mcp add --transport http --scope user ${CONNECT_SERVER_NAME} ${mcpUrl(orgSlug)}`;
}
