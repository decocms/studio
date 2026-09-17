/**
 * Draft-preview projection for blog posts.
 *
 * A post that isn't scheduled/published yet lives as a *planning* block under
 * `blog-manager/posts/<id>` with NO `__resolveType`, so the storefront never
 * renders unfinished work in production (the invariant the web CMS relies on).
 * That same invariant means "See preview" has nothing to render — the post has
 * no route.
 *
 * This runs ONLY on the anonymous, signed draft pull the storefront makes to
 * overlay a `?__draft=` preview (never on editor-session reads, never on
 * publish, never on normal production traffic). For that pull alone it exposes
 * each planning post as a renderable `collections/blog/posts/<id>` block, so the
 * preview shows the post exactly as it will look — while production, which reads
 * the committed blocks (no `__resolveType`), stays blind to it.
 *
 * Web source of truth for these conventions: `blog/blog-data.ts`
 * (`PLANNING_POST_KEY_PREFIX`, `livePostKey`, the post loader resolveType). They
 * are duplicated here because the `apps/web ↛ apps/api` boundary forbids the
 * import; a divergence would only weaken preview, never production.
 */

const PLANNING_POST_PREFIX = "blog-manager/posts/";
const LIVE_POST_PREFIX = "collections/blog/posts/";
const FALLBACK_POST_RESOLVE_TYPE = "blog/loaders/Blogpost.ts";
/** Wrapper field holding a post's editable payload in a loader block. */
const POST_WRAPPER = "post";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Use the `__resolveType` the site's own live posts carry, so a projected post
 * resolves through the exact loader this storefront renders with. Falls back to
 * the well-known deco blog loader when the site has no posts yet.
 */
function detectPostResolveType(doc: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(doc)) {
    if (!key.startsWith(LIVE_POST_PREFIX)) continue;
    const rt = asRecord(value)?.__resolveType;
    if (typeof rt === "string" && rt) return rt;
  }
  return FALLBACK_POST_RESOLVE_TYPE;
}

/**
 * Project planning posts into renderable post blocks for a preview pull. Pure:
 * takes and returns the merged decofile JSON text, unchanged when there is
 * nothing to project (so the common no-planning-posts case is a cheap parse).
 * The projected block forces a `published` status so the app's status filter
 * renders it — it exists only in this single preview response.
 */
export function projectPlanningPostsForPreview(decofileJson: string): string {
  let doc: Record<string, unknown> | null;
  try {
    doc = asRecord(JSON.parse(decofileJson));
  } catch {
    return decofileJson;
  }
  if (!doc) return decofileJson;

  const resolveType = detectPostResolveType(doc);
  const out: Record<string, unknown> = { ...doc };
  let projected = 0;

  for (const [key, value] of Object.entries(doc)) {
    if (!key.startsWith(PLANNING_POST_PREFIX)) continue;
    const block = asRecord(value);
    const payload = block && asRecord(block[POST_WRAPPER]);
    if (!payload) continue;
    // A soft-deleted post shouldn't resurface in preview.
    if (payload.status === "archived") continue;
    // Without a slug there is no route to render, so projecting is pointless.
    if (typeof payload.slug !== "string" || !payload.slug) continue;

    const id = key.slice(PLANNING_POST_PREFIX.length);
    const liveKey = `${LIVE_POST_PREFIX}${id}`;
    if (Object.hasOwn(out, liveKey)) continue;

    out[liveKey] = {
      name: liveKey,
      __resolveType: resolveType,
      [POST_WRAPPER]: { ...payload, status: "published" },
    };
    projected++;
  }

  return projected > 0 ? JSON.stringify(out) : decofileJson;
}
