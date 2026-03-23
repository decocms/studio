/**
 * Shared constants for MCP Mesh
 *
 * Constants used by both server-side and web code.
 */

/** MCP Mesh metadata key in tool _meta */
export const MCP_MESH_KEY = "mcp.mesh";

/**
 * Default timeout for MCP tool calls in milliseconds.
 * The MCP SDK default is 60 seconds (60000ms).
 * Increase this value for tools that take longer to execute.
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
