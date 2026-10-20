import type { LiveMeta } from "./resolve-schema";
import { isLazyWrapper, unwrapLazy, wrapLazy } from "./lazy-value";
import {
  PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
  SECTION_MULTIVARIATE_RESOLVE_TYPE,
} from "./section-types";

/**
 * Variants, in the two shapes Studio reads and writes.
 *
 * - v7 (and Fresh/Deno): `website/flags/multivariate/section.ts` around one
 *   section, `website/flags/multivariate.ts` around anything else (a page's
 *   section list, a hidden array item). Each variant's `value` is stored plain.
 * - Blocks v8: the built-in `multivariate`, for every kind of value. Each
 *   variant's `value` is a `lazy` block around the value, so only the picked
 *   variant resolves (`@decocms/blocks` `builtins/multivariate.ts`; `deco
 *   check` reports a plain value as "a variant's value must be a lazy block").
 *
 * A v8 site still resolves the v7 names (its schema maps them to
 * `multivariate` and the runtime wraps their plain values on the way), so
 * existing v7-shaped variants keep working there. Studio writes the v8 shape
 * only for variants it creates; a block it edits keeps its own name and the
 * shape that name expects.
 */

/** The built-in variants block of Blocks v8. */
export const V8_MULTIVARIATE_RESOLVE_TYPE = "multivariate";

/** The v7 names of the variants block that Studio writes. */
const LEGACY_MULTIVARIATE_RESOLVE_TYPES = new Set([
  PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
  SECTION_MULTIVARIATE_RESOLVE_TYPE,
]);

type SiteMeta = Pick<LiveMeta, "manifest"> | null | undefined;

/**
 * Whether the site's schema lists the built-in `multivariate` (Blocks v8
 * lists it under `loaders`). Without a schema, the v7 names are written.
 */
export function declaresV8Multivariate(meta: SiteMeta): boolean {
  const groups = meta?.manifest?.blocks ?? {};
  return Object.values(groups).some((group) =>
    Object.hasOwn(group ?? {}, V8_MULTIVARIATE_RESOLVE_TYPE),
  );
}

/** The type a NEW variants block around one section is saved with. */
export function sectionMultivariateResolveType(meta: SiteMeta): string {
  return declaresV8Multivariate(meta)
    ? V8_MULTIVARIATE_RESOLVE_TYPE
    : SECTION_MULTIVARIATE_RESOLVE_TYPE;
}

/**
 * The type a NEW variants block around any other value (a page's section
 * list, a hidden array item) is saved with.
 */
export function valueMultivariateResolveType(meta: SiteMeta): string {
  return declaresV8Multivariate(meta)
    ? V8_MULTIVARIATE_RESOLVE_TYPE
    : PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE;
}

/** Whether a type is the variants block, by its v8 name or a v7 one. */
export function isMultivariateResolveType(resolveType: unknown): boolean {
  return (
    typeof resolveType === "string" &&
    (resolveType === V8_MULTIVARIATE_RESOLVE_TYPE ||
      LEGACY_MULTIVARIATE_RESOLVE_TYPES.has(resolveType))
  );
}

/** Whether variants under this type store each value in a `lazy` block. */
function storesLazyVariantValues(resolveType: unknown): boolean {
  return resolveType === V8_MULTIVARIATE_RESOLVE_TYPE;
}

/** A variant's value as the editor shows it: past the `lazy` block, if any. */
export function readVariantValue(variant: unknown): unknown {
  if (!variant || typeof variant !== "object") return undefined;
  return unwrapLazy((variant as { value?: unknown }).value);
}

/**
 * A value in the form its variants block stores it: in a `lazy` block under
 * `multivariate`, or when the variant already held one; plain otherwise.
 */
export function storeVariantValue(
  containerResolveType: unknown,
  value: unknown,
  previous?: unknown,
): unknown {
  return storesLazyVariantValues(containerResolveType) ||
    isLazyWrapper(previous)
    ? wrapLazy(value)
    : value;
}

/** The variant with a new value, kept in the shape its block stores. */
export function withVariantValue<T extends Record<string, unknown>>(
  containerResolveType: unknown,
  variant: T,
  value: unknown,
): T {
  return {
    ...variant,
    value: storeVariantValue(containerResolveType, value, variant.value),
  };
}
