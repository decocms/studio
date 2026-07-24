/**
 * Virtual MCP Schema Re-exports
 *
 * Re-exports schemas from @decocms/shared/sdk to maintain a single source of truth.
 * This file exists to preserve existing import paths while delegating to the SDK.
 */

// Re-export all schemas and types from studio-sdk
export {
  VirtualMCPEntitySchema,
  VirtualMCPCreateDataSchema,
  VirtualMCPUpdateDataSchema,
  type VirtualMCPEntity,
  type VirtualMCPCreateData,
  type VirtualMCPUpdateData,
  type VirtualMCPConnection,
  type KnowledgeFile,
} from "@decocms/shared/sdk/types";
