import { z } from "zod";
import { postIdOfKey } from "./blog-post-id";

/** The Blog view's collections, in the order its sidebar lists them. */
const BLOG_COLLECTION_IDS = [
  "context",
  "posts",
  "authors",
  "categories",
  "post-schedule",
] as const;

export type BlogCollectionId = (typeof BLOG_COLLECTION_IDS)[number];

const blogCollectionSchema = z.enum(BLOG_COLLECTION_IDS);

/**
 * Search the Blog browser owns.
 *
 * `blogItem` is a decofile block key, not an id: authors and categories have
 * exactly one block shape each, so their key IS their identity. Posts are the
 * exception and get a path param instead — see `blog-post-id.ts`.
 */
export const blogSearchShape = {
  blogCollection: blogCollectionSchema.optional(),
  blogItem: z.string().optional(),
} as const;

export type BlogSearchParams = z.infer<z.ZodObject<typeof blogSearchShape>>;

/**
 * The collection actually shown.
 *
 * Context is the one collection an org can turn off, and `?blogCollection=`
 * puts it in the URL — so a stale link, or an admin flipping the AI-blog flag
 * while someone is standing on it, would otherwise render a tab the menu no
 * longer lists. Normalising once at the source spares every reader downstream
 * a guard of its own.
 */
export function visibleBlogCollection(
  active: BlogCollectionId,
  blogAi: boolean,
): BlogCollectionId {
  return active === "context" && !blogAi ? "posts" : active;
}

/** Which pane of the post editor is showing. Only decides anything on a panel
 *  too narrow for both; above the breakpoint it collapses the preview. */
const blogPostViewSchema = z.enum(["edit", "preview"]);

export type BlogPostView = z.infer<typeof blogPostViewSchema>;

export const blogPostSearchShape = {
  blogView: blogPostViewSchema.optional(),
} as const;

/** Where a Blog Manager content deep link should land, or `null` when the
 *  search carries none. A post resolves to its id; every other collection
 *  opens the browser with the record selected. */
export function blogDeepLinkTarget(search: {
  contentCollection?: string;
  contentItem?: string;
}): { collection: BlogCollectionId; item?: string; postId?: string } | null {
  const parsed = blogCollectionSchema.safeParse(search.contentCollection);
  if (!parsed.success) return null;
  const collection = parsed.data;
  const item = search.contentItem;
  if (collection === "posts") {
    // No item means no post to open, so the list is the honest destination.
    return item ? { collection, postId: postIdOfKey(item) } : { collection };
  }
  return item ? { collection, item } : { collection };
}
