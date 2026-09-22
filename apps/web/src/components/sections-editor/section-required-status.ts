import { arrayItemDisplayValue } from "./array-item-hidden";
import { isEmptyFieldValue } from "./fields/required-field-context";
import {
  resolveSchema,
  type LiveMeta,
  type SchemaProperty,
} from "./resolve-schema";
import type { ParsedSection } from "./parse-sections";
import type { RawSection } from "./section-types";
import { unwrapSection } from "./unwrap-section";

/** Internal deco props the form never renders — see schema-form's HIDDEN_PROPS. */
const HIDDEN_PROPS = new Set(["__resolveType", "@type"]);

/**
 * The value to validate for an array item: a hidden item unwrapped to its inner
 * value (the form does the same via `arrayItemDisplayValue`). Returns
 * `SKIP_ARRAY_ITEM` for anything still carrying a `__resolveType` — a
 * block/multivariate wrapper whose shape can't be checked against the plain
 * item schema and would otherwise read as an empty required prop.
 */
const SKIP_ARRAY_ITEM = Symbol("skip-array-item");
function arrayItemValueToValidate(
  item: unknown,
): unknown | typeof SKIP_ARRAY_ITEM {
  const display = arrayItemDisplayValue(item);
  if (
    display != null &&
    typeof display === "object" &&
    !Array.isArray(display) &&
    typeof (display as Record<string, unknown>).__resolveType === "string"
  ) {
    return SKIP_ARRAY_ITEM;
  }
  return display;
}

/** Matches schema-form's structural descent cap; a section tree is far shallower. */
const MAX_DEPTH = 32;

/**
 * Whether an object's config is missing a required prop the open form would
 * flag as empty. Mirrors schema-form's per-object
 * `required && isEmptyFieldValue(value[key])` rule (skipping hidden props),
 * recursing through nested plain-object properties and plain-object array items
 * — the same places the form renders a required marker. Block-ref/section
 * arrays (whose items are wrappers, not plain objects) are skipped via the
 * `items.properties` guard, so their null-hole `required` guard never counts.
 */
export function hasMissingRequiredField(
  schema: SchemaProperty | null | undefined,
  value: unknown,
  depth = 0,
): boolean {
  if (!schema?.properties || depth > MAX_DEPTH) return false;
  const properties = schema.properties;
  const obj =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  for (const key of schema.required ?? []) {
    if (HIDDEN_PROPS.has(key) || properties[key]?.hidden === true) continue;
    if (isEmptyFieldValue(obj[key])) return true;
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    const childValue = obj[key];
    if (childValue == null) continue;
    if (
      childSchema.properties &&
      typeof childValue === "object" &&
      !Array.isArray(childValue) &&
      hasMissingRequiredField(childSchema, childValue, depth + 1)
    ) {
      return true;
    }
    if (
      childSchema.items?.properties &&
      Array.isArray(childValue) &&
      childValue.some((item) => {
        const itemValue = arrayItemValueToValidate(item);
        return (
          itemValue !== SKIP_ARRAY_ITEM &&
          hasMissingRequiredField(childSchema.items, itemValue, depth + 1)
        );
      })
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a section row's real inner block (past saved/lazy/multivariate
 * wrappers) and report whether it has an empty required prop. `false` for
 * multivariate rows and anything that fails to resolve — the dot is an
 * accelerator, never a blocker.
 */
export function sectionHasMissingRequiredField(
  raw: RawSection | undefined,
  parsed: ParsedSection | undefined,
  decofile: Record<string, unknown>,
  meta: LiveMeta | null | undefined,
): boolean {
  if (!raw || !parsed || !meta) return false;
  try {
    const unwrapped = unwrapSection(raw, parsed, decofile);
    if (!unwrapped) return false;
    const schema = resolveSchema(unwrapped.resolveType, meta);
    return hasMissingRequiredField(schema, unwrapped.data);
  } catch {
    return false;
  }
}
