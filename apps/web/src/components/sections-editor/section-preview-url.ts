/** Matches admin `encodeProps` — URI-encode then base64. */
export function encodePreviewProps(json: string): string {
  return btoa(encodeURIComponent(json));
}

/** Preview URL for a saved global block (single section on a blank page). */
export function buildGlobalSectionPreviewUrl(
  previewBaseUrl: string,
  livePageResolveType: string,
  blockKey: string,
): string {
  const origin = new URL(previewBaseUrl).origin;
  const url = new URL(
    `/live/previews/${encodeURIComponent(livePageResolveType)}`,
    origin,
  );
  url.searchParams.set("path", "/");
  url.searchParams.set("pathTemplate", "/");
  url.searchParams.set(
    "props",
    encodePreviewProps(
      JSON.stringify({
        path: "/",
        sections: [{ __resolveType: blockKey }],
      }),
    ),
  );
  url.searchParams.set("__cb", crypto.randomUUID());
  return url.toString();
}

/**
 * Fast Preview URL — the site's own page, rendered against the working-tree
 * draft.
 *
 * Points at the REAL page on `productionUrl` and carries a `?__draft=` pointer.
 * The site's framework resolves that pointer by fetching the merged decofile
 * from the sandbox daemon (`<handle>.<suffix>/_sandbox/decofile`) and rendering
 * its own routes against it.
 *
 * This replaces pushing the decofile into a POST body: only deco's own runtime
 * honours a POST render, while Next.js and most frameworks render on GET. Going
 * through the site's normal route also means hydration and in-preview
 * navigation work, instead of a single statically-rendered component.
 *
 * The token is `<host[:port]>@<version>` — the AUTHORITY of the daemon origin,
 * never a full URL. The site validates it against its configured preview-API
 * domains and derives the scheme itself, so there is no SSRF surface, and the
 * authority carries the desktop link's per-run port for free. `version` is the
 * daemon's content ETag: the site caches per version, and a new version after
 * a save is what refreshes the frame — no cache-busting nonce needed.
 */
export function buildDraftPreviewUrl(input: {
  /** Published site origin — the draft renders against this deployment. */
  productionUrl: string;
  /** Daemon origin (`previewUrl`); its authority becomes the token's host. */
  previewUrl: string;
  /** Draft content version (the daemon's ETag), from the `decofile` event. */
  version: string;
  /** Path to render, with any `:param` values already filled in. */
  path: string;
}): string {
  const url = new URL(input.path, input.productionUrl);
  const host = new URL(input.previewUrl).host;
  url.searchParams.set("__draft", `${host}@${input.version}`);
  return url.toString();
}

export function buildSectionPreviewUrl(
  previewBaseUrl: string,
  livePageResolveType: string,
  block: string,
  theme?: Record<string, unknown>,
): string {
  const origin = new URL(previewBaseUrl).origin;
  const url = new URL(
    `/live/previews/${encodeURIComponent(livePageResolveType)}`,
    origin,
  );
  url.searchParams.set("__d", "");
  const sections: unknown[] = [{ __resolveType: "preview", block }];
  if (theme) sections.push(theme);
  url.searchParams.set(
    "props",
    encodePreviewProps(JSON.stringify({ sections })),
  );
  return url.toString();
}

/**
 * Base origin for the section-gallery previews (`/live/previews`).
 *
 * Section thumbnails render a single ISOLATED component via deco's runtime
 * `/live/previews` route, so the base must be a deco-runtime origin. This is a
 * mode switch, not a boot fallback:
 *   - Fast Preview ON  → ALWAYS the production deployment, for the whole
 *     session. It does not depend on the sandbox being up and never swaps back
 *     to it — like the main canvas, which also paints production whenever Fast
 *     Preview is on. Renders against DEPLOYED code, which is representative for
 *     a "pick a section" gallery.
 *   - Fast Preview OFF → the sandbox dev server (the previous behaviour).
 *
 * Unlike `buildDraftPreviewUrl` (framework-agnostic, GET on the site's real
 * routes), there is no framework-agnostic way to render one isolated component,
 * so the production path only works when production is itself a deco-runtime
 * site — the same assumption the sandbox dev server already satisfies.
 *
 * Returns `null` when neither base is available (no sandbox URL and Fast
 * Preview off), so the caller can withhold the gallery entirely.
 */
export function resolveSectionPreviewBase(input: {
  sandboxUrl: string | null | undefined;
  productionUrl: string | null | undefined;
  fastPreviewActive: boolean;
}): string | null {
  if (input.fastPreviewActive && input.productionUrl) {
    return input.productionUrl;
  }
  return input.sandboxUrl ?? null;
}
