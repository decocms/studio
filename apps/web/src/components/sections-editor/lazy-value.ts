/**
 * `Lazy<T>` fields: `deco schema` writes one as a `lazy` block whose `value`
 * has the form of `T`. Editors fill in a `T`; the form writes the block
 * around it and never shows the wrapper.
 */

import type { SchemaProperty } from "./resolve-schema";

const LAZY = "lazy";

/** Whether a stored value is the `lazy` block the editor writes around a `Lazy<T>` field. */
export function isLazyWrapper(
  value: unknown,
): value is { __resolveType: "lazy"; value: unknown } {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).__resolveType === LAZY &&
    "value" in value
  );
}

/** The value inside a `lazy` block; anything else as is. */
export function unwrapLazy(value: unknown): unknown {
  return isLazyWrapper(value) ? value.value : value;
}

/** Wraps a value in the `lazy` block; `undefined` stays unset. */
export function wrapLazy(value: unknown): unknown {
  if (value === undefined) return undefined;
  return isLazyWrapper(value) ? value : { __resolveType: LAZY, value };
}

/** Whether a field's schema is a `lazy` block (`Lazy<T>`), with `value` holding `T`'s form. */
export function isLazyFieldSchema(
  schema: SchemaProperty,
): schema is SchemaProperty & {
  properties: { value: SchemaProperty };
} {
  return schema.lazy === true && !!schema.properties?.value;
}
