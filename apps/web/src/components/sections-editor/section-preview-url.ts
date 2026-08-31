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

/** Query param carrying the Fast Preview draft pointer. */
const DRAFT_PARAM = "__draft";

/**
 * The `?__draft=` pointer a site's framework resolves to render unpublished
 * content: it fetches the merged decofile from Studio's decofile API
 * (`/api/:org/decofile/:virtualMcpId/:branch?token=…`) and renders its own
 * routes against it, so hydration and in-preview navigation keep working.
 *
 * The pointer is `<authority><path>?token=…@<version>` — never a full URL. The
 * runtime splits on the LAST `@`, validates only the authority against its
 * configured preview-API domains, and derives the scheme itself, so there is
 * no SSRF surface. `version` is the branch head commit sha: the site caches
 * per version, and a new version after a save is what refreshes the frame —
 * no cache-busting nonce needed.
 */
export function buildDraftPointer(input: {
  /**
   * Studio API authority (host[:port]) serving /api — reported by the
   * decofile API itself (DecofileDraft.apiHost). Not window.location.host:
   * in the native app that is the session-gated tauri-local server, which
   * the preview server cannot pull the draft from.
   */
  apiHost: string;
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  /** Signed draft grant from the decofile API. */
  token: string;
  /** Branch head commit sha. */
  version: string;
}): string {
  const pointer = `${input.apiHost}/api/${input.orgSlug}/decofile/${encodeURIComponent(input.virtualMcpId)}/${encodeURIComponent(input.branch)}?token=${input.token}`;
  return `${pointer}@${input.version}`;
}

/** `__draft` value asking for the PUBLISHED render — external contract: the site runtime honours it, Studio never reads it back. */
export const DRAFT_OFF = "off";

/**
 * Stamp a draft pointer — or {@link DRAFT_OFF} — onto an already-built site
 * URL. Callers that compute their own path (blog post/category links) build the
 * URL first and decorate here; a null pointer (Fast Preview off, or no grant
 * yet) leaves it alone.
 */
export function withDraftPointer(
  url: string,
  draftPointer: string | null | undefined,
): string {
  if (!draftPointer) return url;
  const next = new URL(url);
  next.searchParams.set(DRAFT_PARAM, draftPointer);
  return next.toString();
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
  url.searchParams.set(DRAFT_PARAM, buildDraftPointer(input));
  return url.toString();
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
