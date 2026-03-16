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

// Re-export schema types (only types, not runtime schemas)
export type {
  VirtualMCPConnection,
  VirtualMCPEntity,
  VirtualMCPCreateData,
  VirtualMCPUpdateData,
} from "./schema";
