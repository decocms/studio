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
 * Fast Preview URL. Points at the sandbox **daemon**'s `/_sandbox/fast-preview`
 * route (served from `previewUrl`, the daemon origin). The daemon merges the
 * working-tree `.deco/blocks/*` into a decofile and POSTs it — server-side, no
 * URL-size cap, no CORS — to the site's production `/live/previews/<pageBlockKey>`
 * (the always-on deco runtime), returning the rendered draft with a `<base>`
 * pointing at production so assets resolve there.
 *
 * The decofile is NOT in this URL (the daemon reads it from disk), so the frame
 * just needs re-navigating when content changes — bump `nonce` to force it.
 * `pageBlockKey` is the decofile key of the page (e.g. `pages-home-…`).
 */
export function buildFastPreviewDaemonUrl(input: {
  previewUrl: string;
  pageBlockKey: string;
  path: string;
  pathTemplate: string;
  nonce: number | string;
}): string {
  const url = new URL("/_sandbox/fast-preview", input.previewUrl);
  url.searchParams.set("component", input.pageBlockKey);
  url.searchParams.set("path", input.path);
  url.searchParams.set("pathTemplate", input.pathTemplate);
  // Re-navigation nonce: the daemon re-reads `.deco/blocks/*` on each request,
  // so a fresh value forces the frame to reload the latest draft after a save.
  url.searchParams.set("__cb", String(input.nonce));
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
