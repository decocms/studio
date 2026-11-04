import { buildDraftPointer, withDraftPointer } from "@decocms/shared/blog";
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
  const url = globalSectionPreviewUrl(
    previewBaseUrl,
    livePageResolveType,
    blockKey,
  );
  url.searchParams.set("__cb", crypto.randomUUID());
  return url.toString();
}

/** {@link buildGlobalSectionPreviewUrl} without the cache-buster, for callers that render it every pass. */
export function globalSectionPreviewUrl(
  previewBaseUrl: string,
  livePageResolveType: string,
  blockKey: string,
): URL {
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
  return url;
}

/**
 * Fast Preview URL — the site's own page on `previewServerUrl`, carrying the
 * {@link buildDraftPointer} grant so it renders the unpublished draft.
 */
export function buildFastPreviewDraftUrl(
  input: Parameters<typeof buildDraftPointer>[0] & {
    /** Preview server origin — the deployment the draft renders against. */
    previewServerUrl: string;
    /** Path to render, with any `:param` values already filled in. */
    path: string;
  },
): string {
  const url = new URL(input.path, input.previewServerUrl);
  return withDraftPointer(url.toString(), buildDraftPointer(input));
}

/**
 * Fast Preview in-place render request — the old admin's `/live/previews` POST,
 * revived for the main canvas.
 *
 * Instead of committing to git and re-navigating the iframe to a `?__draft=@sha`
 * URL (a ~15s GitHub round-trip), this POSTs the CURRENT page block plus the
 * merged-with-unsaved decofile to the deco runtime's
 * `/live/previews/:pageResolveType`. The runtime builds a throwaway resolver
 * from the inline `__decofile` and server-renders the page from unsaved state,
 * returning HTML the injected editor script swaps into the frame in place. No
 * commit, no reload.
 *
 * Body shape matches the runtime's `getPropsFromRequest` + inline-decofile
 * branch: `{ __props, __decofile }`, where the handler renders `:pageResolveType`
 * with `__props` and resolves the page's section `$ref`s against `__decofile`.
 * `__decoFBT=0` disables deferred rendering so one POST returns the whole page.
 *
 * Returns null when the page block has no `__resolveType` (nothing to render).
 * deco-runtime only — the same assumption `resolveSectionPreviewBase` documents.
 */
export function buildPageRenderRequest(input: {
  /** The frame's own origin (Fast Preview production deployment). */
  previewBaseUrl: string;
  /** The current page block from the merged decofile: `{ __resolveType, path, sections, … }`. */
  pageBlock: Record<string, unknown>;
  /** The full merged decofile, including the unsaved edit (KEYS.decofile). */
  decofile: Record<string, unknown>;
  /** Resolved path (`:param`s filled) for matcher/routing context. */
  path: string;
  /** Path template, so the page stays matched. */
  pathTemplate: string;
}): { src: string; body: string } | null {
  const resolveType = input.pageBlock.__resolveType;
  if (typeof resolveType !== "string" || !resolveType) return null;
  const origin = new URL(input.previewBaseUrl).origin;
  const url = new URL(
    `/live/previews/${encodeURIComponent(resolveType)}`,
    origin,
  );
  url.searchParams.set("__decoFBT", "0");
  url.searchParams.set("__d", "");
  url.searchParams.set("path", input.path);
  url.searchParams.set("pathTemplate", input.pathTemplate);
  const { __resolveType: _resolveType, ...props } = input.pageBlock;
  const body = JSON.stringify({ __props: props, __decofile: input.decofile });
  return { src: url.toString(), body };
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
  previewServerUrl: string | null | undefined;
  fastPreviewActive: boolean;
}): string | null {
  if (input.fastPreviewActive && input.previewServerUrl) {
    return input.previewServerUrl;
  }
  return input.sandboxUrl ?? null;
}
