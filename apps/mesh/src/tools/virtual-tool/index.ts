/**
 * Virtual Tool Management Tools
 *
 * Export all virtual tool-related tools with collection binding compliance.
 * Virtual tools are custom JavaScript tools defined on Virtual MCPs.
 */

// Collection-compliant CRUD tools
export { VIRTUAL_TOOLS_CREATE } from "./create";
export { VIRTUAL_TOOLS_LIST } from "./list";
export { VIRTUAL_TOOLS_GET } from "./get";
export { VIRTUAL_TOOLS_UPDATE } from "./update";
export { VIRTUAL_TOOLS_DELETE } from "./delete";

// Re-export schema types
export type {
  VirtualToolEntity,
  VirtualToolCreateData,
  VirtualToolUpdateData,
  VirtualToolDefinition,
} from "./schema";
