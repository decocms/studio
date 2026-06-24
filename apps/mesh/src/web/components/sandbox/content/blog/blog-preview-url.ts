const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/**
 * The deco blog app block exposes a `pageSlug` route template such as
 * `/blogteste/:category/:slug`. We read it from whichever decofile block
 * resolves to the blog app (`site/apps/<vendor>/blog.ts`) and substitute the
 * `:category` / `:slug` params with the post being edited so a "See preview"
 * button can open the live sandbox page for that post.
 */
const BLOG_APP_RESOLVE_TYPE = /\/blog\.tsx?$/;

export function findBlogPageSlug(
  decofile: Record<string, unknown>,
): string | null {
  for (const [key, val] of Object.entries(decofile)) {
    if (key.includes("/")) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const obj = val as Record<string, unknown>;
    if (typeof obj.__resolveType !== "string") continue;
    if (!BLOG_APP_RESOLVE_TYPE.test(obj.__resolveType)) continue;
    const slug = str(obj.pageSlug);
    if (slug) return slug;
  }
  return null;
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
