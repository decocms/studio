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
 * The pointer is `<handle>@<version>`, never a URL — the site builds the origin
 * from a configured suffix, so there is no SSRF surface. `version` is the
 * daemon's content ETag, so the site caches per version and re-fetches only
 * when the draft actually changes; a new version after a save is what refreshes
 * the frame, which is why no cache-busting nonce is needed here.
 */
export function buildDraftPreviewUrl(input: {
  /** Published site origin — the draft renders against this deployment. */
  productionUrl: string;
  /** Sandbox handle; the site resolves it under its configured origin suffix. */
  sandboxHandle: string;
  /** Draft content version (the daemon's ETag), from the `decofile` event. */
  version: string;
  /** Path to render, with any `:param` values already filled in. */
  path: string;
}): string {
  const url = new URL(input.path, input.productionUrl);
  url.searchParams.set("__draft", `${input.sandboxHandle}@${input.version}`);
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
