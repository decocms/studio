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

export function findBlogPageSlug(
  decofile: Record<string, unknown>,
): string | null {
  return readBlogAppProp(decofile, "pageSlug");
}

export function findBlogCategorySlug(
  decofile: Record<string, unknown>,
): string | null {
  return readBlogAppProp(decofile, "categorySlug");
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

// The `categorySlug` template's dynamic segment for the category slug — deco
// has used `:category`, `:slug` and `:categorySlug` across versions.
const HAS_CATEGORY_PARAM = /:(?:categorySlug|category|slug)\??/;
const ALL_CATEGORY_PARAMS = /:(?:categorySlug|category|slug)\??/g;

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
}: {
  decofile: Record<string, unknown>;
  category: Record<string, unknown>;
  previewBaseUrl: string | null | undefined;
}): string | null {
  if (!previewBaseUrl) return null;
  const template = findBlogCategorySlug(decofile);
  if (!template) return null;

  const path = applyBlogCategorySlug(template, str(category.slug));
  if (!path) return null;

  try {
    return new URL(path, previewBaseUrl).href;
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
}: {
  decofile: Record<string, unknown>;
  post: Record<string, unknown>;
  previewBaseUrl: string | null | undefined;
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
    return new URL(path, previewBaseUrl).href;
  } catch {
    return null;
  }
}
