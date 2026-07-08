import {
  NEVER_MATCHER_RESOLVE_TYPE,
  PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
} from "./section-types";

/**
 * Hiding an array item mirrors how a page section is hidden: wrap the item value
 * in a generic multivariate flag whose single variant is gated by a `never`
 * matcher, so the deco resolver resolves it to nothing on the live site.
 *
 * Unlike sections we use the value-generic `website/flags/multivariate.ts`
 * (`PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE`) instead of the section-specific flag,
 * since array items are plain values (banners, links, …), not sections.
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

/** True when the item is wrapped in a multivariate + `never` matcher. */
export function isArrayItemHidden(item: unknown): boolean {
  const wrap = asWrap(item);
  const first = wrap?.variants?.[0];
  return first?.rule?.__resolveType === NEVER_MATCHER_RESOLVE_TYPE;
}

/** Wrap an item value so it never renders on the live site. */
export function hideArrayItem(value: unknown): HiddenItemWrap {
  return {
    __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
    variants: [{ value, rule: { __resolveType: NEVER_MATCHER_RESOLVE_TYPE } }],
  };
}

/** Unwrap a hidden item back to the underlying value it was hiding. */
export function showArrayItem(item: unknown): unknown {
  if (!isArrayItemHidden(item)) return item;
  return asWrap(item)?.variants?.[0]?.value;
}

/**
 * The value to display / edit for an array item: the inner value when hidden,
 * the item itself otherwise. Keeps labels, images and the drill-in editor
 * working for hidden items.
 */
export function arrayItemDisplayValue(item: unknown): unknown {
  return isArrayItemHidden(item) ? showArrayItem(item) : item;
}
