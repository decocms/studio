/**
 * The request Studio sends for a deployed site's `/live/_meta`.
 *
 * The edge blocks the schema routes on public hosts unless a request carries
 * the admin token, so the CMS asks through Studio instead of fetching the site
 * from the browser. The path is fixed and the origin comes from the project,
 * never from the request.
 */

import {
  defaultPreviewServerUrl,
  resolvePreviewServerUrl,
} from "@decocms/shared/deco-site-production-url";

export const SITE_ADMIN_TOKEN_HEADER = "x-deco-admin-token";

export interface SiteMetaTarget {
  siteUrl: string;
  /** Whether the admin token may travel with the request. */
  trusted: boolean;
}

export function projectSiteSlug(
  metadata: Record<string, unknown> | null,
): string | null {
  return typeof metadata?.siteSlug === "string" && metadata.siteSlug
    ? metadata.siteSlug
    : null;
}

/**
 * The token is one secret for every site, so it only goes to the platform's
 * host for a site the caller's org owns (`org_sites`). A project can name any
 * slug, and `previewServerUrl` is free text any editor can point anywhere:
 * those are read without the token.
 */
export function resolveSiteMetaTarget(
  metadata: Record<string, unknown> | null,
  orgOwnsSite: boolean,
): SiteMetaTarget | null {
  const platformUrl = orgOwnsSite
    ? defaultPreviewServerUrl(projectSiteSlug(metadata))
    : null;
  if (platformUrl && isTrustedSiteOrigin(platformUrl)) {
    return { siteUrl: platformUrl, trusted: true };
  }
  const editorUrl = resolvePreviewServerUrl(metadata);
  return editorUrl ? { siteUrl: editorUrl, trusted: false } : null;
}

export function isTrustedSiteOrigin(siteUrl: string): boolean {
  const url = new URL(siteUrl);
  return url.protocol === "https:" && url.hostname.endsWith(".deco.site");
}

export interface SiteMetaRequest {
  url: string;
  headers: Record<string, string>;
}

export function buildSiteMetaRequest(input: {
  target: SiteMetaTarget;
  ifNoneMatch?: string | null;
  adminToken?: string | null;
}): SiteMetaRequest {
  const url = new URL("/live/_meta", input.target.siteUrl).href;
  const headers: Record<string, string> = { accept: "application/json" };
  // The edge in front of Studio compresses the response and weakens its etag
  // (`W/"…"`). If-None-Match compares weakly, but the runtime matches the
  // string exactly, so it gets the tag back as the site issued it.
  const etag = input.ifNoneMatch?.replace(/^W\//, "");
  if (etag) headers["if-none-match"] = etag;
  if (input.adminToken && input.target.trusted) {
    headers[SITE_ADMIN_TOKEN_HEADER] = input.adminToken;
  }
  return { url, headers };
}

export function isJsonContentType(contentType: string | null): boolean {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type === "application/json" || !!type?.endsWith("+json");
}

/**
 * The response is served from Studio's origin, so it is always JSON that the
 * browser must not sniff, whatever the upstream claimed.
 */
export function siteMetaResponseHeaders(
  upstream: Headers,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "no-store",
  };
  const etag = upstream.get("etag");
  if (etag) headers.etag = etag;
  return headers;
}
