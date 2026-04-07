/**
 * Matches the MCP client prefix added by coding agents (e.g. Claude Code).
 * "mcp__cms__conn-abc_hello_world" → "conn-abc_hello_world"
 */
const MCP_SERVER_PREFIX = /^mcp__[a-zA-Z0-9_-]+__/;

/**
 * Strip the MCP server prefix from a tool/prompt name.
 */
export function stripMcpServerPrefix(name: string): string {
  return name.replace(MCP_SERVER_PREFIX, "");
}
