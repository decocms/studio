/**
 * Virtual MCP Schema Re-exports
 *
 * Re-exports schemas from @decocms/mesh-sdk to maintain a single source of truth.
 * This file exists to preserve existing import paths while delegating to the SDK.
 */

// Re-export all schemas and types from mesh-sdk
export {
  VirtualMCPEntitySchema,
  VirtualMCPCreateDataSchema,
  VirtualMCPUpdateDataSchema,
  type VirtualMCPEntity,
  type VirtualMCPCreateData,
  type VirtualMCPUpdateData,
  type VirtualMCPConnection,
  type VirtualMCPSlot,
} from "@decocms/mesh-sdk/types";
