/**
 * Shared helpers for building this org's unified MCP endpoint URL and the
 * one-line `claude mcp add` command. Kept in one place so the topbar "LINK"
 * dialog and the full Connect settings page can't drift apart.
 */

/**
 * MCP server name registered in the client's config — derived from the current
 * host so each Studio deployment gets a distinct entry and adding two never
 * collides. `claude mcp add <name>` only accepts letters, numbers, hyphens and
 * underscores, so the host's dots are sanitized to hyphens:
 * `studio.decocms.com` → `studio-decocms-com`, `belo-horizonte.localhost` →
 * `belo-horizonte-localhost`. Falls back to `studio` during SSR (no `window`).
 */
export function connectServerName(): string {
  const host =
    typeof window === "undefined" ? "" : window.location.hostname || "";
  const sanitized = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "studio";
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
