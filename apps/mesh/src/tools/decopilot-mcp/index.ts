/**
 * Cluster-side MCP tools that desktop decopilot calls remotely via the
 * injected mcp.url token. In-cluster runs continue to use the built-in
 * versions directly (no MCP round-trip).
 *
 * These tools are registered in CORE_TOOLS (tools/index.ts) so they appear
 * on the management MCP server, which is reachable via the `{orgId}_self`
 * connection that every decopilot agent includes in its connections list.
 */
export { UPDATE_INTERESTS_MCP } from "./update-interests-tool";
