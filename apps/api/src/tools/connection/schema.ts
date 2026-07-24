/**
 * Connection Schema Re-exports
 *
 * Re-exports schemas from @decocms/shared/sdk to maintain a single source of truth.
 * This file exists to preserve existing import paths while delegating to the SDK.
 */

// Re-export all schemas, types, and utility functions from studio-sdk
export {
  ConnectionEntitySchema,
  ConnectionCreateDataSchema,
  ConnectionUpdateDataSchema,
  isStdioParameters,
  parseVirtualUrl,
  buildVirtualUrl,
  type ConnectionEntity,
  type ConnectionCreateData,
  type ConnectionUpdateData,
  type ConnectionParameters,
  type HttpConnectionParameters,
  type StdioConnectionParameters,
  type OAuthConfig,
  type ToolDefinition,
} from "@decocms/shared/sdk/types";
