import { BaseCollectionEntitySchema } from "@decocms/bindings/collections";
import { z } from "zod";

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  additionalProperties?: boolean | Record<string, unknown>;
  additionalItems?: boolean | Record<string, unknown>;
  items?: JsonSchema;
  format?: string;
  enum?: string[];
  maxLength?: number;
  anyOf?: JsonSchema[];
  [key: string]: unknown;
};

// Re-export from core for backwards compatibility
export { MCP_MESH_KEY as MCP_MESH_DECOCMS_KEY } from "@/core/constants";

/**
 * Base collection JSONSchema
 * Generated from BaseCollectionEntitySchema using Zod's native JSON Schema conversion.
 */
export const BaseCollectionJsonSchema: JsonSchema = z.toJSONSchema(
  BaseCollectionEntitySchema,
  { target: "draft-7" },
) as JsonSchema;
