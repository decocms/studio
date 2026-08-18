import type { LiveMeta } from "./resolve-schema";

export type RawSchema = Record<string, unknown>;

function schemaDefinitions(meta: LiveMeta): Record<string, RawSchema> {
  return (meta.schema?.definitions ?? meta.schema?.$defs ?? {}) as Record<
    string,
    RawSchema
  >;
}

/**
 * A section's own definition (`definitions[btoa(resolveType)]`) plus its
 * `allOf → Props` definition, in lookup order. deco emits `@field` metadata
 * (`@title`, `@image`, …) on either, so callers read their field off the first
 * schema in the chain that carries it.
 */
export function sectionSchemaChain(
  resolveType: string,
  meta: LiveMeta,
): RawSchema[] {
  const definitions = schemaDefinitions(meta);
  const schema = definitions[btoa(resolveType)];
  if (!schema) return [];

  const chain = [schema];
  if (Array.isArray(schema.allOf)) {
    const ref = (schema.allOf as RawSchema[]).find(
      (part) => typeof part.$ref === "string",
    )?.$ref;
    if (typeof ref === "string") {
      const propsSchema = definitions[ref.replace("#/definitions/", "")];
      if (propsSchema) chain.push(propsSchema);
    }
  }
  return chain;
}
