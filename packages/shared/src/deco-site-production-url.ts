/**
 * Site-URL helpers for linked deco.cx sites.
 *
 * The URL the CMS preview renders against is persisted on the agent's
 * `metadata.previewServerUrl` (legacy key: `metadata.productionUrl` — written
 * by imports before the rename and still read as a fallback). It is usually
 * the live production site, but any deco-runtime deployment works (staging, a
 * local `https://localhost:3100`, ...), which is why the canonical name is
 * "preview server". We deliberately do NOT derive it from `siteSlug` (the
 * `{slug}.deco.site` guess) — a site's real URL can be a custom domain, so we
 * persist what deco.cx actually reports at import time.
 */

/** Validate/normalize a stored site URL. Returns the canonical href or `null`. */
export function sanitizeSiteUrl(
  value: string | null | undefined,
): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * The ONE reader for the preview server URL: `previewServerUrl` wins, the
 * legacy `productionUrl` key is the fallback. Every consumer (web gate, API
 * gate, preview surfaces) goes through here so the dual-read lives in exactly
 * one place; writers write `previewServerUrl` only.
 */
export function resolvePreviewServerUrl(
  metadata:
    | { previewServerUrl?: string | null; productionUrl?: string | null }
    | null
    | undefined,
): string | null {
  return (
    sanitizeSiteUrl(metadata?.previewServerUrl) ??
    sanitizeSiteUrl(metadata?.productionUrl)
  );
}

/**
 * Pick the site's production domain from the deco.cx `domains` list: the one
 * flagged `production`, else the first. Returns `undefined` when there are none.
 */
export function pickProductionDomain(
  domains: { domain: string; production: boolean }[] | null | undefined,
): string | undefined {
  return domains?.find((d) => d.production)?.domain ?? domains?.[0]?.domain;
}

/**
 * Build a site URL from a deco.cx domain. Domains come back as bare hosts
 * (e.g. `acme.com`, `acme.deco.site`), so we prepend `https://` when no scheme
 * is present, then validate. Returns `null` for empty/whitespace/invalid input.
 */
export function productionUrlFromDomain(
  domain: string | null | undefined,
): string | null {
  const raw = domain?.trim();
  if (!raw) return null;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return sanitizeSiteUrl(withProtocol);
}
