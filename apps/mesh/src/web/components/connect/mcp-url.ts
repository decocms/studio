/**
 * Shared helpers for building this org's unified MCP endpoint URL and the
 * one-line `claude mcp add` command. Kept in one place so the topbar "LINK"
 * dialog and the full Connect settings page can't drift apart.
 */

/**
 * MCP server name registered in the client's config — derived from the current
 * host so each Studio deployment gets a distinct entry and adding two never
 * collides: `studio.decocms.com` in prod, `belo-horizonte.localhost` locally.
 * Falls back to `studio` during SSR (no `window`).
 */
export function connectServerName(): string {
  if (typeof window === "undefined") return "studio";
  return window.location.hostname || "studio";
}

/**
 * The org-scoped MCP endpoint a client should connect to:
 * `<origin>/api/<slug>/mcp/self`.
 *
 * NOT the bare aggregate `/api/<slug>/mcp` — that resolves to the Decopilot
 * agent, which is a pure orchestrator with NO directly-callable tools (it routes
 * everything through sub-agents via `subtask`), so an external client sees zero
 * tools. `/mcp/self` is the org's own management surface: Library files, agents,
 * connections, automations, brand, AI providers, secrets — i.e. everything you
 * need to actually drive the org from Claude.
 */
export function mcpUrl(orgSlug: string): string {
  const origin =
    typeof window === "undefined"
      ? "http://localhost:3000"
      : window.location.origin;
  return `${origin}/api/${orgSlug}/mcp/self`;
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
  return `claude mcp add --transport http --scope user ${connectServerName()} ${mcpUrl(orgSlug)} --header "Authorization: Bearer ${apiKey}"`;
}
