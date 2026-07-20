/** Favicon URL for a data source logo (64 px, Google favicon service). */
const fav = (domain: string) =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

/**
 * Fallback logo map keyed by normalized source name (lowercase, trimmed).
 * Used when the engine sends an empty logoUrl — covers the ~15 sources that
 * appear in real decks so ~90 % of pills show an icon without engine changes.
 * Manual / CLI sources (inspeção pública, curl) are intentionally absent.
 */
const LOGO_MAP: Record<string, string> = {
  // Google tools — all share the same Chrome developer favicon
  "google analytics 4": fav("analytics.google.com"),
  ga4: fav("analytics.google.com"),
  "google analytics": fav("analytics.google.com"),
  "google search console": fav("search.google.com"),
  "search console": fav("search.google.com"),
  gsc: fav("search.google.com"),
  "gsc url inspection": fav("search.google.com"),
  "google tag manager": fav("tagmanager.google.com"),
  gtm: fav("tagmanager.google.com"),
  "google ads": fav("ads.google.com"),
  "keyword planner": fav("ads.google.com"),
  "merchant center": fav("merchants.google.com"),
  "google merchant center": fav("merchants.google.com"),
  "pagespeed insights": fav("pagespeed.web.dev"),
  psi: fav("pagespeed.web.dev"),
  lighthouse: fav("developer.chrome.com"),
  "chrome ux report": fav("developer.chrome.com"),
  crux: fav("developer.chrome.com"),
  "chrome devtools": fav("developer.chrome.com"),
  // Third-party tools
  webpagetest: fav("webpagetest.org"),
  semrush: fav("semrush.com"),
  similarweb: fav("similarweb.com"),
  ahrefs: fav("ahrefs.com"),
  moz: fav("moz.com"),
  "screaming frog": fav("screamingfrog.co.uk"),
  builtwith: fav("builtwith.com"),
  microlink: fav("microlink.io"),
  apify: fav("apify.com"),
  firecrawl: fav("firecrawl.dev"),
  "reclame aqui": fav("reclameaqui.com.br"),
  instagram: fav("instagram.com"),
  meta: fav("meta.com"),
  "meta business manager": fav("business.facebook.com"),
  // E-commerce platforms
  vtex: fav("vtex.com"),
  "vtex oms": fav("vtex.com"),
  shopify: fav("shopify.com"),
  linx: fav("linx.com.br"),
  wake: fav("wake.com"),
};

/** Returns a logo URL for a source name, falling back to the lookup table
 *  when the engine-supplied logoUrl is absent. Returns "" if unknown. */
export function resolveLogoUrl(name: string, logoUrl: string): string {
  if (logoUrl) return logoUrl;
  return LOGO_MAP[name.toLowerCase().trim()] ?? "";
}
