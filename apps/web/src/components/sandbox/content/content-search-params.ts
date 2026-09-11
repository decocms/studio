import { z } from "zod";

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
 */
export const contentSearchParams = {
  contentPageId: z.string().optional(),
  contentPath: z.string().optional(),
  contentPathTemplate: z.string().optional(),
  contentCollection: z.string().optional(),
  contentItem: z.string().optional(),
} as const;

export type ContentSearchParams = z.infer<
  z.ZodObject<typeof contentSearchParams>
>;
