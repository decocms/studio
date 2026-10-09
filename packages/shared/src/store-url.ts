/**
 * Putting a store URL back on the store's own domain.
 *
 * The catalogue loaders are invoked through `catalog-invoke`, whose origin is
 * the deco runtime — a sandbox, or `{slug}.deco.site`. So the URLs they report
 * carry whatever host the platform answered on, typically the VTEX account's
 * `*.vtexcommercestable.com.br`. That address works, which is what makes it
 * dangerous: nothing fails, it just gets published.
 *
 * The path is the part the store actually authored; the origin is an accident
 * of how we asked. So keep the path and put the brand's own `storeUrl` in front
 * of it.
 */

import { sanitizeSiteUrl } from "./deco-site-production-url";

/** Lets a relative path parse; only pathname/search/hash are read back out. */
const RELATIVE_BASE = "https://placeholder.invalid";

/**
 * `url` on the brand's storefront domain, or unchanged when it cannot be.
 *
 * Returns the input untouched whenever `storeUrl` is missing or unusable — a
 * blank brand field must never make a working link worse than it was.
 *
 * Also the join for a bare slug: a catalogue API answers with `linkText` rather
 * than an address, and `/mochila-frozen/p` resolved against the store is a link
 * the store itself authored. Shared because both ends need it — the editor when
 * someone picks a product, the generator when a tool reported only the slug.
 */
export function reHome(url: string | undefined, storeUrl: string): string {
  const raw = (url ?? "").trim();
  if (!raw) return "";

  const base = sanitizeSiteUrl(storeUrl.trim());
  if (!base) return raw;

  try {
    const parsed = new URL(raw, RELATIVE_BASE);
    const rehomed = new URL(base);
    rehomed.pathname = parsed.pathname;
    rehomed.search = parsed.search;
    rehomed.hash = parsed.hash;
    return rehomed.href;
  } catch {
    return raw;
  }
}
