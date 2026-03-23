/**
 * Virtual MCP Management Tools
 *
 * Export all virtual MCP-related tools with collection binding compliance.
 */

// Collection-compliant CRUD tools
export { COLLECTION_VIRTUAL_MCP_CREATE } from "./create";
export { COLLECTION_VIRTUAL_MCP_LIST } from "./list";
export { COLLECTION_VIRTUAL_MCP_GET } from "./get";
export { COLLECTION_VIRTUAL_MCP_UPDATE } from "./update";
export { COLLECTION_VIRTUAL_MCP_DELETE } from "./delete";

// Virtual MCP plugin config and pinned views tools
export { VIRTUAL_MCP_PLUGIN_CONFIG_GET } from "./plugin-config-get";
export { VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE } from "./plugin-config-update";
export { VIRTUAL_MCP_PINNED_VIEWS_UPDATE } from "./pinned-views-update";

// Re-export schema types (only types, not runtime schemas)
export type {
  VirtualMCPConnection,
  VirtualMCPEntity,
  VirtualMCPCreateData,
  VirtualMCPUpdateData,
} from "./schema";
