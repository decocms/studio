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
 * Project planning posts into renderable post blocks for a preview pull. Fed
 * every merged block in document order, so it runs inside the streaming merge
 * instead of re-parsing the whole document. The projected post reuses the
 * `__resolveType` the site's first live post carries (the exact loader this
 * storefront renders with), falling back to the well-known deco blog loader,
 * and forces a `published` status so the app's status filter renders it — it
 * exists only in the preview response.
 */
export function createPreviewProjection() {
  let resolveType: string | null = null;
  const liveKeys = new Set<string>();
  const planning: Array<{ id: string; payload: Record<string, unknown> }> = [];
  return {
    add(key: string, value: unknown): void {
      if (key.startsWith(LIVE_POST_PREFIX)) {
        liveKeys.add(key);
        const rt = asRecord(value)?.__resolveType;
        if (resolveType === null && typeof rt === "string" && rt) {
          resolveType = rt;
        }
        return;
      }
      if (!key.startsWith(PLANNING_POST_PREFIX)) return;
      const block = asRecord(value);
      const payload = block && asRecord(block[POST_WRAPPER]);
      if (!payload) return;
      // A soft-deleted post shouldn't resurface in preview.
      if (payload.status === "archived") return;
      // Without a slug there is no route to render, so projecting is pointless.
      if (typeof payload.slug !== "string" || !payload.slug) return;
      planning.push({ id: key.slice(PLANNING_POST_PREFIX.length), payload });
    },
    /** Comma-joined `"key":value` members to append; "" when none. */
    members(): string {
      return planning
        .filter(({ id }) => !liveKeys.has(`${LIVE_POST_PREFIX}${id}`))
        .map(({ id, payload }) => {
          const liveKey = `${LIVE_POST_PREFIX}${id}`;
          const block = {
            name: liveKey,
            __resolveType: resolveType ?? FALLBACK_POST_RESOLVE_TYPE,
            [POST_WRAPPER]: { ...payload, status: "published" },
          };
          return `${JSON.stringify(liveKey)}:${JSON.stringify(block)}`;
        })
        .join(",");
    },
  };
}
