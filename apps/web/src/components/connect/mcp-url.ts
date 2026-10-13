/**
 * Shared helpers for building this org's unified MCP endpoint URL and the
 * one-line `claude mcp add` command. Kept in one place so the topbar "LINK"
 * dialog and the full Connect settings page can't drift apart.
 */

/**
 * Per-deployment, per-org MCP server name (`studio-decocms-com-acme`), limited
 * to the characters `claude mcp add` accepts.
 */
export function connectServerName(orgSlug: string): string {
  const host =
    typeof window === "undefined" ? "" : window.location.hostname || "";
  return (
    [host, orgSlug]
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "studio"
  );
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
