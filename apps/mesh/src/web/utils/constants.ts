import { BaseCollectionEntitySchema } from "@decocms/bindings/collections";
import type { JsonSchema } from "@decocms/bindings/workflow";
import { z } from "zod";

// Re-export from core for backwards compatibility
export { MCP_MESH_KEY as MCP_MESH_DECOCMS_KEY } from "@/core/constants";

/**
 * Canonical app_id of the GitHub MCP connection in the registry.
 *
 * This is the value stored in `connections.app_id` for installed GitHub
 * connections (registry apps are scoped as `<publisher>/<name>`). It is NOT
 * the same as the connection `slug` (`mcp-github`). Connection resolution
 * (CONNECTION_RESOLVE_FOR_USER / resolveSlot) matches on `app_id`, so passing
 * the bare slug here resolves nothing and leaves the GitHub picker stuck on
 * "Installing the GitHub connection…".
 */
export const GITHUB_APP_ID = "deco/mcp-github";

export type { JsonSchema };

/**
 * Base collection JSONSchema
 * Generated from BaseCollectionEntitySchema using Zod's native JSON Schema conversion.
 */
export const BaseCollectionJsonSchema: JsonSchema = z.toJSONSchema(
  BaseCollectionEntitySchema,
  { target: "draft-7" },
) as JsonSchema;
