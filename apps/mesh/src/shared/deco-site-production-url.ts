/**
 * Production-URL helpers for linked deco.cx sites.
 *
 * The live production URL is persisted on the agent's `metadata.productionUrl`
 * at import time and painted in the preview iframe while the sandbox dev server
 * wakes (Lovable-style). We deliberately do NOT derive it from `siteSlug` (the
 * `{slug}.deco.site` guess) — a site's real production URL can be a custom
 * domain, so we persist what deco.cx actually reports.
 */

/** Validate/normalize a stored production URL. Returns the canonical href or `null`. */
export function sanitizeProductionUrl(
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
 * Build a production URL from a deco.cx domain. Domains come back as bare hosts
 * (e.g. `acme.com`, `acme.deco.site`), so we prepend `https://` when no scheme
 * is present, then validate. Returns `null` for empty/whitespace/invalid input.
 */
export function productionUrlFromDomain(
  domain: string | null | undefined,
): string | null {
  const raw = domain?.trim();
  if (!raw) return null;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return sanitizeProductionUrl(withProtocol);
}
