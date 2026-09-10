import { withDraftPointer } from "@/components/sections-editor/section-preview-url";
import { extractPathParams } from "@/components/sections-editor/page-path-utils";

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/**
 * The deco blog app block exposes route templates: `pageSlug` for a single
 * post (e.g. `/blogteste/:category/:slug`) and `categorySlug` for a category
 * listing page (e.g. `/blogteste/:category`). We read them from whichever
 * decofile block resolves to the blog app (`site/apps/<vendor>/blog.ts`) and
 * substitute the params so "See preview" buttons can open the live sandbox
 * page for the post/category being edited.
 */
const BLOG_APP_RESOLVE_TYPE = /\/blog\.tsx?$/;

/** Reads a string prop off the (single) blog app block, if present. */
function readBlogAppProp(
  decofile: Record<string, unknown>,
  prop: string,
): string | null {
  for (const [key, val] of Object.entries(decofile)) {
    if (key.includes("/")) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const obj = val as Record<string, unknown>;
    if (typeof obj.__resolveType !== "string") continue;
    if (!BLOG_APP_RESOLVE_TYPE.test(obj.__resolveType)) continue;
    const value = str(obj[prop]);
    if (value) return value;
  }
  return null;
}

/**
 * The blog app's `pageSlug`/`categorySlug` props are optional and most sites
 * (blog-manager-generated ones included) never set them — the actual post and
 * category routes live in decofile Page blocks instead (a
 * `website/pages/Page.tsx` / `$live/pages/LivePage.tsx` with a `path`). When
 * the app block omits the prop we recover the template from that Page block so
 * "See preview" still works. A Page is the blog post/category page when its
 * section tree includes the well-known full-page section (`BlogPostPage` /
 * `BlogCategoryPage`); we pick the fewest-param match so a paginated variant
 * (`…/page/:page`) never shadows the canonical route.
 */
const PAGE_RESOLVE_TYPES = new Set([
  "website/pages/Page.tsx",
  "$live/pages/LivePage.tsx",
]);

/** The `path` of a decofile Page block, or `null` for any other block shape. */
function pageBlockPath(block: unknown): string | null {
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const obj = block as Record<string, unknown>;
  if (typeof obj.__resolveType !== "string") return null;
  if (!PAGE_RESOLVE_TYPES.has(obj.__resolveType)) return null;
  return typeof obj.path === "string" ? obj.path : null;
}

/** Count the dynamic params in a path template, ignoring the `*` catch-all. */
function paramCount(path: string): number {
  return extractPathParams(path).filter((name) => name !== "*").length;
}

/**
 * Finds the path template of the Page block whose section tree references the
 * given full-page section marker (e.g. `BlogPostPage`), preferring the
 * fewest-param candidate. Returns `null` when no Page matches.
 */
function findBlogPageTemplateByMarker(
  decofile: Record<string, unknown>,
  marker: RegExp,
): string | null {
  let best: string | null = null;
  let bestParams = Number.POSITIVE_INFINITY;
  for (const block of Object.values(decofile)) {
    const path = pageBlockPath(block);
    if (!path) continue;
    if (!marker.test(JSON.stringify(block))) continue;
    const params = paramCount(path);
    if (params < bestParams) {
      best = path;
      bestParams = params;
    }
  }
  return best;
}

/** Full-page section markers — never the `BlogPost*`/`BlogCategory*` body
 * sections — so the post and category pages can't cross-match. */
const BLOG_POST_PAGE_MARKER = /blogpostpage/i;
const BLOG_CATEGORY_PAGE_MARKER = /blogcategorypage/i;

export function findBlogPageSlug(
  decofile: Record<string, unknown>,
): string | null {
  return (
    readBlogAppProp(decofile, "pageSlug") ??
    findBlogPageTemplateByMarker(decofile, BLOG_POST_PAGE_MARKER)
  );
}

export function findBlogCategorySlug(
  decofile: Record<string, unknown>,
): string | null {
  return (
    readBlogAppProp(decofile, "categorySlug") ??
    findBlogPageTemplateByMarker(decofile, BLOG_CATEGORY_PAGE_MARKER)
  );
}

export function firstCategorySlug(post: Record<string, unknown>): string {
  const categories = post.categories;
  if (!Array.isArray(categories) || categories.length === 0) return "";
  const first = categories[0] as Record<string, unknown> | null;
  return str(first?.slug);
}

/**
 * Substitutes `:category` / `:slug` (optionally suffixed with `?`) in the
 * route template. Returns `null` when a required param is missing so callers
 * can disable the preview action instead of opening a broken URL.
 */
export function applyBlogPageSlug(
  template: string,
  params: { category: string; slug: string },
): string | null {
  let path = template;
  if (/:category\??/.test(path)) {
    if (!params.category) return null;
    path = path.replace(/:category\??/g, encodeURIComponent(params.category));
  }
  if (/:slug\??/.test(path)) {
    if (!params.slug) return null;
    path = path.replace(/:slug\??/g, encodeURIComponent(params.slug));
  }
  return path;
}

// Category route param names deco has used (`categoria` before `category` so the longer pt-BR match wins).
const HAS_CATEGORY_PARAM = /:(?:categorySlug|categoria|category|slug)\??/;
const ALL_CATEGORY_PARAMS = /:(?:categorySlug|categoria|category|slug)\??/g;

/**
 * Substitutes the category slug into the blog app's `categorySlug` route
 * template. A template with no dynamic segment is treated as a static
 * listing page and returned unchanged; otherwise returns `null` when the
 * category has no slug so callers can hide the preview action.
 */
export function applyBlogCategorySlug(
  template: string,
  slug: string,
): string | null {
  if (!HAS_CATEGORY_PARAM.test(template)) return template;
  if (!slug) return null;
  return template.replace(ALL_CATEGORY_PARAMS, encodeURIComponent(slug));
}

/**
 * Builds the absolute preview URL for a category listing page, or `null` when
 * it can't be built (no `categorySlug` configured on the blog app, no preview
 * origin, or a missing slug).
 */
export function buildBlogCategoryPreviewUrl({
  decofile,
  category,
  previewBaseUrl,
  draftPointer,
}: {
  decofile: Record<string, unknown>;
  category: Record<string, unknown>;
  previewBaseUrl: string | null | undefined;
  /** Fast Preview grant, so the link opens the unpublished draft. */
  draftPointer?: string | null;
}): string | null {
  if (!previewBaseUrl) return null;
  const template = findBlogCategorySlug(decofile);
  if (!template) return null;

  const path = applyBlogCategorySlug(template, str(category.slug));
  if (!path) return null;

  try {
    return withDraftPointer(new URL(path, previewBaseUrl).href, draftPointer);
  } catch {
    return null;
  }
}

/**
 * Builds the absolute preview URL for a post, or `null` when it can't be
 * built (no blog app block, no preview origin, or a missing route param).
 */
export function buildBlogPostPreviewUrl({
  decofile,
  post,
  previewBaseUrl,
  draftPointer,
}: {
  decofile: Record<string, unknown>;
  post: Record<string, unknown>;
  previewBaseUrl: string | null | undefined;
  /** Fast Preview grant, so the link opens the unpublished draft. */
  draftPointer?: string | null;
}): string | null {
  if (!previewBaseUrl) return null;
  const template = findBlogPageSlug(decofile);
  if (!template) return null;

  const path = applyBlogPageSlug(template, {
    category: firstCategorySlug(post),
    slug: str(post.slug),
  });
  if (!path) return null;

  try {
    return withDraftPointer(new URL(path, previewBaseUrl).href, draftPointer);
  } catch {
    return null;
  }
}
