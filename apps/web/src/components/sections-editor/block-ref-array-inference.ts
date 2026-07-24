import type { SchemaProperty } from "./resolve-schema";

/**
 * When a block-ref field holds a resolved plain array, prefer the real item
 * schema declared by one of the block-ref's loader/section branches
 * (`anyOfRefs`) over one inferred from the runtime data. The declared schema
 * carries metadata that data inference cannot recover — the `titleBy` array-item
 * label template (e.g. `@title {{{route}}}`), field `format` (rich-text), and
 * `@image` thumbnail templates.
 *
 * A deco loader that injects an `X[]` prop exposes that array as one of its own
 * props with the same shape, so the item schema lives at
 * `ref.schema.properties.<k>.items` — or directly at `ref.schema.items` when a
 * branch is the array itself. We pick the candidate whose properties best cover
 * the keys present in the data, so an unrelated array prop on the same loader
 * can't hijack the render.
 */
export function blockRefArrayItemSchemaFromRefs(
  schema: SchemaProperty,
  value: unknown[],
): SchemaProperty | undefined {
  const refs = schema.anyOfRefs;
  if (!refs?.length) return undefined;

  const first = value.find(
    (v) => v != null && typeof v === "object" && !Array.isArray(v),
  ) as Record<string, unknown> | undefined;
  const dataKeys = first
    ? Object.keys(first).filter((k) => !k.startsWith("__"))
    : [];

  const candidates: SchemaProperty[] = [];
  const collect = (items?: SchemaProperty) => {
    if (items?.type === "object" && items.properties) candidates.push(items);
  };
  for (const ref of refs) {
    const s = ref.schema;
    if (!s) continue;
    if (s.type === "array") collect(s.items);
    if (s.properties) {
      for (const prop of Object.values(s.properties)) {
        if (prop?.type === "array") collect(prop.items);
      }
    }
  }
  if (candidates.length === 0) return undefined;

  // No data to disambiguate (empty array) — only safe with a single candidate.
  if (dataKeys.length === 0) {
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  let best: SchemaProperty | undefined;
  let bestScore = -1;
  for (const cand of candidates) {
    const props = cand.properties ?? {};
    // Prefer higher key coverage; break ties toward a declared titleBy.
    const score =
      dataKeys.filter((k) => k in props).length * 2 + (cand.titleBy ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  // Require at least one overlapping key so an unrelated array (coverage 0)
  // can't win purely on a titleBy tie-break.
  return bestScore >= 2 ? best : undefined;
}

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
