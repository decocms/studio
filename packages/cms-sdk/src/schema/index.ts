/**
 * Schema Utilities
 *
 * Utilities for fetching and working with JSON Schema from deco sites.
 */

/**
 * JSON Schema type definition
 */
export interface JSONSchema {
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JSONSchema>;
  definitions?: Record<string, JSONSchema>;
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  properties?: Record<string, JSONSchema>;
  additionalProperties?: boolean | JSONSchema;
  required?: string[];
  items?: JSONSchema | JSONSchema[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
  if?: JSONSchema;
  then?: JSONSchema;
  else?: JSONSchema;
  // Custom extensions
  "x-widget"?: string;
  [key: string]: unknown;
}

/**
 * MetaInfo returned from /live/_meta endpoint
 */
export interface MetaInfo {
  version: string;
  namespace: string;
  site: string;
  etag: string;
  timestamp: number;
  schema: JSONSchema;
  manifest: {
    blocks: Record<string, Record<string, JSONSchema>>;
  };
}

/**
 * Fetch metadata from a deco site.
 *
 * @example
 * const meta = await fetchMeta('https://mysite.deco.site');
 * console.log(meta.version); // '1.0.0'
 */
export async function fetchMeta(siteUrl: string): Promise<MetaInfo> {
  const response = await fetch(`${siteUrl}/live/_meta`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch meta: ${response.status}`);
  }

  return response.json();
}

/**
 * Get the JSON Schema for a specific block type.
 *
 * @example
 * const schema = getBlockSchema(meta, 'website/pages/Page.tsx');
 */
export function getBlockSchema(
  meta: MetaInfo,
  resolveType: string
): JSONSchema | null {
  if (!meta?.manifest?.blocks) return null;

  for (const [_, blocks] of Object.entries(meta.manifest.blocks)) {
    if (blocks[resolveType]) {
      return {
        ...meta.schema,
        ...blocks[resolveType],
      };
    }
  }

  return null;
}

/**
 * Resolve $ref references in a JSON Schema.
 *
 * @example
 * const resolved = resolveRefs(schema, rootSchema);
 */
export function resolveRefs(
  schema: JSONSchema,
  rootSchema: JSONSchema
): JSONSchema {
  if (!schema) return schema;

  // Handle $ref
  if (schema.$ref) {
    const refPath = schema.$ref;

    // Handle local refs like "#/definitions/Foo"
    if (refPath.startsWith("#/")) {
      const path = refPath.slice(2).split("/");
      let resolved: unknown = rootSchema;

      for (const segment of path) {
        if (resolved && typeof resolved === "object") {
          resolved = (resolved as Record<string, unknown>)[segment];
        } else {
          return schema; // Can't resolve
        }
      }

      if (resolved && typeof resolved === "object") {
        return resolveRefs(resolved as JSONSchema, rootSchema);
      }
    }

    return schema;
  }

  // Recursively resolve refs in nested schemas
  const result: JSONSchema = { ...schema };

  if (result.properties) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([key, value]) => [
        key,
        resolveRefs(value, rootSchema),
      ])
    );
  }

  if (result.items) {
    if (Array.isArray(result.items)) {
      result.items = result.items.map((item) => resolveRefs(item, rootSchema));
    } else {
      result.items = resolveRefs(result.items, rootSchema);
    }
  }

  if (result.oneOf) {
    result.oneOf = result.oneOf.map((s) => resolveRefs(s, rootSchema));
  }

  if (result.anyOf) {
    result.anyOf = result.anyOf.map((s) => resolveRefs(s, rootSchema));
  }

  if (result.allOf) {
    result.allOf = result.allOf.map((s) => resolveRefs(s, rootSchema));
  }

  if (
    result.additionalProperties &&
    typeof result.additionalProperties === "object"
  ) {
    result.additionalProperties = resolveRefs(
      result.additionalProperties,
      rootSchema
    );
  }

  return result;
}

/**
 * Get all block types from manifest organized by category.
 */
export function getBlocksByCategory(meta: MetaInfo): Record<string, string[]> {
  if (!meta?.manifest?.blocks) return {};

  const result: Record<string, string[]> = {};

  for (const [category, blocks] of Object.entries(meta.manifest.blocks)) {
    result[category] = Object.keys(blocks);
  }

  return result;
}

/**
 * Check if a schema represents a section/block selector.
 */
export function isSectionSelector(schema: JSONSchema): boolean {
  // Check for common patterns that indicate a section selector
  if (schema.oneOf || schema.anyOf) {
    const variants = schema.oneOf || schema.anyOf;
    return variants.some(
      (v) =>
        v.properties?.__resolveType ||
        v.$ref?.includes("Section") ||
        v.$ref?.includes("Block")
    );
  }

  return false;
}

