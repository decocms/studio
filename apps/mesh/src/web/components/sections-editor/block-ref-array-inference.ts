import type { SchemaProperty } from "./resolve-schema";

/**
 * When a block-ref field holds a resolved plain array (the loader has already
 * been evaluated), infer a minimal item schema from the first element so the
 * array can be rendered as an editable ArrayField.
 * Only primitive types (string, number, boolean) are inferred — nested
 * objects/arrays are intentionally skipped.
 */
export function inferBlockRefArrayItemSchema(
  value: unknown[],
): SchemaProperty | undefined {
  const first = value.length > 0 ? value[0] : undefined;
  if (first == null || typeof first !== "object" || Array.isArray(first)) {
    return undefined;
  }
  const properties: Record<string, SchemaProperty> = {};
  for (const [k, v] of Object.entries(first as Record<string, unknown>)) {
    if (k.startsWith("__")) continue;
    if (typeof v === "string") properties[k] = { type: "string" };
    else if (typeof v === "number") properties[k] = { type: "number" };
    else if (typeof v === "boolean") properties[k] = { type: "boolean" };
  }
  return Object.keys(properties).length > 0
    ? { type: "object", properties }
    : undefined;
}
