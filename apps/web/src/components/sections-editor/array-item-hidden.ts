import type { LiveMeta } from "./resolve-schema";
import {
  isNeverMatcherResolveType,
  neverMatcherResolveType,
} from "./section-types";
import {
  storeVariantValue,
  V8_MULTIVARIATE_RESOLVE_TYPE,
  valueMultivariateResolveType,
  variantValueOn,
} from "./variant-shape";

/**
 * Hiding an array item mirrors how a page section is hidden: wrap the item value
 * in a generic multivariate flag whose single variant is gated by a `never`
 * matcher, so the deco resolver resolves it to nothing on the live site.
 *
 * Unlike sections we use the value-generic `website/flags/multivariate.ts`
 * (`PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE`) instead of the section-specific flag,
 * since array items are plain values (banners, links, …), not sections. A
 * Blocks v8 site gets its built-in `multivariate`, with the value in a `lazy`
 * block (see variant-shape.ts).
 */
interface HiddenItemWrap {
  __resolveType: string;
  variants: Array<{ value?: unknown; rule?: { __resolveType?: string } }>;
}

function asWrap(item: unknown): HiddenItemWrap | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const obj = item as Record<string, unknown>;
  if (!Array.isArray(obj.variants)) return null;
  return obj as unknown as HiddenItemWrap;
}

/**
 * Whether the item's wrapper is a Blocks v8 one: `v8` when the caller knows
 * the site (the form does), else a v8 `multivariate`, the block a v8 schema
 * hides items in (`hideArrayItem`). A v7 variants block is never typed
 * `multivariate` (there it would be a saved block's key).
 */
function wrapIsV8(wrap: HiddenItemWrap | null, v8: boolean | undefined) {
  return v8 ?? wrap?.__resolveType === V8_MULTIVARIATE_RESOLVE_TYPE;
}

/**
 * True when the item is wrapped in a multivariate + `never` matcher. The
 * short `never` counts only on a Blocks v8 site (see `wrapIsV8`): a v7 site
 * reads exactly v7's shape, as before.
 */
export function isArrayItemHidden(item: unknown, v8?: boolean): boolean {
  const wrap = asWrap(item);
  const first = wrap?.variants?.[0];
  return isNeverMatcherResolveType(
    first?.rule?.__resolveType,
    wrapIsV8(wrap, v8),
  );
}

/** Wrap an item value so it never renders on the live site. */
export function hideArrayItem(
  value: unknown,
  meta?: LiveMeta | null,
): HiddenItemWrap {
  const resolveType = valueMultivariateResolveType(meta);
  return {
    __resolveType: resolveType,
    variants: [
      {
        value: storeVariantValue(resolveType, value),
        rule: { __resolveType: neverMatcherResolveType(meta) },
      },
    ],
  };
}

/** Unwrap a hidden item back to the underlying value it was hiding. */
export function showArrayItem(item: unknown, v8?: boolean): unknown {
  if (!isArrayItemHidden(item, v8)) return item;
  const wrap = asWrap(item);
  return variantValueOn(wrap?.variants?.[0], wrapIsV8(wrap, v8));
}

/**
 * The value to display / edit for an array item: the inner value when hidden,
 * the item itself otherwise. Keeps labels, images and the drill-in editor
 * working for hidden items.
 */
export function arrayItemDisplayValue(item: unknown, v8?: boolean): unknown {
  return isArrayItemHidden(item, v8) ? showArrayItem(item, v8) : item;
}
