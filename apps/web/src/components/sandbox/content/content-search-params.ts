import { z } from "zod";
import type { VariantFocus } from "@/components/sections-editor/named-rule-uses";

/**
 * Search params the content editor reads, declared ONCE.
 *
 * `ContentBrowser` reads these with `useSearch({ strict: false })`, which
 * returns the route's VALIDATED search — a param a route's `validateSearch`
 * doesn't declare is stripped by zod before the component ever sees it. Every
 * route that can host the content editor spreads this into its own schema, so
 * a param the browser consumes cannot silently be dropped by the router
 * (which is exactly how the Blog Manager's "Editar no Studio" deep-link
 * landed on the generic Pages list instead of the post).
 *
 * `contentPageId`/`contentPath`/`contentPathTemplate`: storefront "." deep-link
 * (set by `/choose-editor`) — the CMS page id, the concrete URL and its route
 * template. `contentCollection`/`contentItem`: Blog Manager "Editar no Studio"
 * — a blog collection plus the decofile block key of the record to open.
 * `contentPageVariant`/`contentSection`/`contentVariant`: the place in that
 * page or section to open, 0-based ("Open" in a test's "Used by"); a value
 * that isn't a place is dropped, not an error.
 */
const placeIndex = z.number().int().nonnegative().optional().catch(undefined);

export const contentSearchParams = {
  contentPageId: z.string().optional(),
  contentPath: z.string().optional(),
  contentPathTemplate: z.string().optional(),
  contentCollection: z.string().optional(),
  contentItem: z.string().optional(),
  contentPageVariant: placeIndex,
  contentSection: placeIndex,
  contentVariant: placeIndex,
} as const;

export type ContentSearchParams = z.infer<
  z.ZodObject<typeof contentSearchParams>
>;

/** The place to open (`contentPageVariant`…), or `null` when none is given. */
export function variantFocusFromSearch(
  search: ContentSearchParams,
): VariantFocus | null {
  const focus: VariantFocus = {};
  if (search.contentPageVariant !== undefined) {
    focus.pageVariant = search.contentPageVariant;
  }
  if (search.contentSection !== undefined) {
    focus.section = search.contentSection;
  }
  if (search.contentVariant !== undefined) {
    focus.variant = search.contentVariant;
  }
  return Object.keys(focus).length > 0 ? focus : null;
}
