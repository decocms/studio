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
 * Practical ceiling for a `/live/previews` GET URL. Browsers/servers cap URLs
 * around 32–64 KB; we stay under it. A full draft decofile can exceed this — the
 * builder returns `null` past the cap so the caller falls back to the published
 * route rather than emit a truncated / 414-ing URL. A POST body or draft cookie
 * would lift this ceiling (see the instant-preview follow-up).
 */
export const INSTANT_PREVIEW_MAX_URL_LENGTH = 30_000;

/**
 * Instant full-page draft preview URL. Renders the CURRENT working-tree draft of
 * a page against an already-running deco runtime (the live production
 * deployment) via `/live/previews/<pageBlockKey>`, pushing the whole draft
 * `decofile` as a per-request override (`__decofile` query param). The runtime
 * applies it in an `AsyncLocalStorage` scope (`withBlocksOverride`), so real
 * visitors never see the draft, and it resolves every referenced block (the
 * page's own sections, saved globals, loaders, theme) against the draft — a
 * branch-accurate render with no sandbox boot and no CORS (plain cross-origin
 * iframe GET).
 *
 * `pageBlockKey` is the decofile key of the page (e.g. `pages-home-…`); the
 * runtime reads the page block — and thus its `sections` — from the pushed draft.
 *
 * Returns `null` when the encoded URL would exceed
 * {@link INSTANT_PREVIEW_MAX_URL_LENGTH}.
 */
export function buildInstantPagePreviewUrl(input: {
  baseUrl: string;
  pageBlockKey: string;
  path: string;
  decofile: Record<string, unknown>;
  maxUrlLength?: number;
}): string | null {
  const { baseUrl, pageBlockKey, path, decofile } = input;
  const maxUrlLength = input.maxUrlLength ?? INSTANT_PREVIEW_MAX_URL_LENGTH;
  const origin = new URL(baseUrl).origin;
  const url = new URL(
    `/live/previews/${encodeURIComponent(pageBlockKey)}`,
    origin,
  );
  url.searchParams.set("path", path);
  url.searchParams.set("pathTemplate", path);
  // Server does `JSON.parse(decodeURIComponent(param))` on `__decofile`, so the
  // stored value must be the URI-encoded JSON (URLSearchParams round-trips it
  // back to exactly this on the server before that decode).
  url.searchParams.set(
    "__decofile",
    encodeURIComponent(JSON.stringify(decofile)),
  );
  const href = url.toString();
  return href.length > maxUrlLength ? null : href;
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
