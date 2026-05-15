/**
 * Pure schema resolution for /live/_meta JSON Schemas.
 *
 * Resolves $ref, allOf, anyOf into a flat SchemaProperty tree
 * that the form renderer can iterate over.
 */

const MAX_DEPTH = 15;

export interface SchemaProperty {
  type: string;
  title?: string;
  description?: string;
  format?: string;
  enum?: unknown[];
  enumNames?: string[];
  default?: unknown;
  const?: unknown;
  properties?: Record<string, SchemaProperty>;
  items?: SchemaProperty;
  anyOf?: SchemaProperty[];
  required?: string[];
}

export interface LiveMeta {
  manifest: {
    blocks: {
      sections: Record<string, { $ref: string; namespace: string }>;
    };
  };
  schema: {
    definitions: Record<string, unknown>;
  };
}

type RawSchema = Record<string, unknown>;

function isObj(v: unknown): v is RawSchema {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Resolve a $ref pointer like "#/definitions/abc" into the actual schema.
 */
function resolveRef(
  ref: string,
  definitions: Record<string, unknown>,
): RawSchema | null {
  const prefix = "#/definitions/";
  if (!ref.startsWith(prefix)) return null;
  const key = ref.slice(prefix.length);
  const resolved = definitions[key];
  return isObj(resolved) ? resolved : null;
}

/**
 * Recursively dereference a schema, resolving $ref, merging allOf,
 * and flattening into a SchemaProperty.
 */
function flatten(
  raw: unknown,
  definitions: Record<string, unknown>,
  depth: number,
): SchemaProperty | null {
  if (depth > MAX_DEPTH || !isObj(raw)) return null;

  let schema = raw;

  // Resolve $ref
  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, definitions);
    if (!resolved) return null;
    // Merge sibling properties (title, description) with resolved
    const { $ref: _, ...siblings } = schema;
    schema = { ...resolved, ...siblings };
  }

  // Merge allOf
  if (Array.isArray(schema.allOf)) {
    let merged: RawSchema = {};
    for (const entry of schema.allOf) {
      const flat = flatten(entry, definitions, depth + 1);
      if (flat?.properties) {
        merged = {
          ...merged,
          properties: {
            ...(merged.properties as Record<string, unknown> | undefined),
            ...flat.properties,
          },
        };
      }
    }
    const { allOf: _, ...rest } = schema;
    schema = { ...rest, ...merged };
    if (rest.properties && merged.properties) {
      schema.properties = {
        ...(merged.properties as Record<string, unknown>),
        ...(rest.properties as Record<string, unknown>),
      };
    }
  }

  // Determine type
  let type = "string";
  const rawType = schema.type;
  if (typeof rawType === "string") {
    type = rawType;
  } else if (Array.isArray(rawType)) {
    // ["string", "null"] -> "string"
    type = (rawType.find((t: unknown) => t !== "null") as string) ?? "string";
  }

  const result: SchemaProperty = { type };

  if (typeof schema.title === "string") result.title = schema.title;
  if (typeof schema.description === "string")
    result.description = schema.description;
  if (typeof schema.format === "string") result.format = schema.format;
  if (Array.isArray(schema.enum)) result.enum = schema.enum;
  if (Array.isArray(schema.enumNames))
    result.enumNames = schema.enumNames as string[];
  if (schema.default !== undefined) result.default = schema.default;
  if (schema.const !== undefined) result.const = schema.const;

  // anyOf
  if (Array.isArray(schema.anyOf)) {
    const variants: SchemaProperty[] = [];
    for (const variant of schema.anyOf) {
      const flat = flatten(variant, definitions, depth + 1);
      if (flat) variants.push(flat);
    }
    if (variants.length > 0) {
      result.anyOf = variants;
      result.type = "anyOf";
    }
  }

  // Properties (object)
  if (isObj(schema.properties)) {
    const props: Record<string, SchemaProperty> = {};
    const required = Array.isArray(schema.required)
      ? (schema.required as string[])
      : [];
    for (const [key, val] of Object.entries(
      schema.properties as Record<string, unknown>,
    )) {
      const flat = flatten(val, definitions, depth + 1);
      if (flat) props[key] = flat;
    }
    if (Object.keys(props).length > 0) {
      result.properties = props;
      result.type = "object";
    }
    if (required.length > 0) result.required = required;
  }

  // Items (array)
  if (type === "array" && isObj(schema.items)) {
    const flat = flatten(schema.items, definitions, depth + 1);
    if (flat) result.items = flat;
  }

  return result;
}

/**
 * Get the list of available sections from /live/_meta.
 */
export function getSectionTypes(meta: LiveMeta): string[] {
  return Object.keys(meta.manifest.blocks.sections);
}

/**
 * Resolve the schema for a given __resolveType.
 * Returns null if the type is not found or is a named block reference.
 */
export function resolveSchema(
  resolveType: string,
  meta: LiveMeta,
): SchemaProperty | null {
  const definitions = meta.schema.definitions;

  // Look up the section in manifest
  const sectionEntry = meta.manifest.blocks.sections[resolveType];
  if (!sectionEntry) {
    // Not a known section type — could be a named block reference
    return null;
  }

  // Resolve the $ref from the manifest entry
  const refKey = sectionEntry.$ref?.replace("#/definitions/", "");
  if (!refKey) return null;

  const sectionSchema = definitions[refKey];
  if (!isObj(sectionSchema)) return null;

  return flatten(sectionSchema, definitions, 0);
}
