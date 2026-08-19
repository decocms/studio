/**
 * Sandbox coordinates the studio preview proxy routes are keyed by. The proxy
 * derives the site origin server-side from the authed claim — the sandbox dev
 * server, or the preview server for a sandbox-less Fast Preview session — so
 * callers never pass a URL and the routes stay SSRF-safe.
 */
export interface PreviewProxyRef {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

interface DecofileFetchInput extends PreviewProxyRef {
  previewUrl?: string | null;
  getFallbackPreviewUrl?: () => string | null;
}

function proxyBase(ref: PreviewProxyRef, route: string): string {
  return `/api/${ref.orgSlug}/sandbox/${encodeURIComponent(ref.virtualMcpId)}/${encodeURIComponent(ref.branch)}/${route}`;
}

/**
 * `GET /api/:org/sandbox/:virtualMcpId/:branch/preview-fetch?path=<path>`. The
 * proxy fetches `<site><path>` server-side so the browser stays out of CORS.
 * `path` may be any same-origin path that can't escape the origin (the proxy
 * rejects protocol-relative / traversal); used to read the site's homepage and
 * listing HTML for link-based entity discovery.
 */
export function buildPreviewFetchPath(
  ref: PreviewProxyRef,
  path: string,
): string {
  const search = new URLSearchParams({ path });
  return `${proxyBase(ref, "preview-fetch")}?${search.toString()}`;
}

/**
 * `POST /api/:org/sandbox/:virtualMcpId/:branch/preview-invoke` with a
 * block-ref body (`{ __resolveType, ...props }`). The proxy re-issues it as
 * `POST <site>/deco/invoke/<resolveType>` with the props as JSON body.
 *
 * Going through the studio (same-origin) instead of fetching the site directly
 * keeps the browser out of CORS territory — deco runtimes don't send
 * `Access-Control-Allow-Origin` for `/deco/invoke`.
 */
export function buildPreviewInvokePath(ref: PreviewProxyRef): string {
  return proxyBase(ref, "preview-invoke");
}

function isBrowserReachableLocalPreview(previewUrl: string): boolean {
  try {
    const { hostname } = new URL(previewUrl);
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

function readPreviewUrlFromDocument(): string | null {
  if (typeof document === "undefined") return null;
  const iframes = Array.from(document.querySelectorAll("iframe"));
  for (const iframe of iframes) {
    const src = iframe.getAttribute("src");
    if (src && isBrowserReachableLocalPreview(src)) return src;
  }
  return null;
}

/**
 * URL for a whitelisted public preview asset. Browser-reachable local previews
 * are hit directly (they allow CORS `*`); cloud previews go through the
 * same-origin `preview-fetch` proxy (which allows `/.decofile` and
 * `/sprites.svg`). `assetPath` must be one the proxy whitelists.
 */
export function buildPreviewFetchUrl(
  input: DecofileFetchInput,
  assetPath: string,
): string {
  const browserPreviewUrl =
    input.previewUrl ??
    input.getFallbackPreviewUrl?.() ??
    readPreviewUrlFromDocument();
  if (browserPreviewUrl && isBrowserReachableLocalPreview(browserPreviewUrl)) {
    return new URL(assetPath, browserPreviewUrl).toString();
  }

  return buildPreviewFetchPath(input, assetPath);
}

export function buildDecofileFetchUrl(input: DecofileFetchInput): string {
  return buildPreviewFetchUrl(input, "/.decofile");
}
