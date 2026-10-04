import type { SchemaProperty } from "./resolve-schema";

/**
 * Props a newly created section or array item starts with: the schema's
 * explicit `@default`s, including those of nested plain objects.
 *
 * The form shows only saved values and the deco runtime does not apply
 * `@default`, so a default reaches the component only if it is written when
 * the value is created. Existing content is never back-filled: a missing key
 * there may be one the user chose to leave unset.
 */
export function schemaDefaults(
  schema: SchemaProperty | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
    if (!prop || key.startsWith("__") || key === "@type") continue;
    if (prop.default !== undefined && prop.default !== null) {
      out[key] = structuredClone(prop.default);
    } else if (prop.type === "object" && prop.properties) {
      const nested = schemaDefaults(prop);
      if (Object.keys(nested).length > 0) out[key] = nested;
    }
  }
  return out;
}
