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
export { SUBTASK_MCP } from "./subtask-tool";
export { TAKE_SCREENSHOT_MCP } from "./take-screenshot-tool";
export { GENERATE_IMAGE_MCP } from "./generate-image-tool";
export { WEB_SEARCH_MCP } from "./web-search-tool";
