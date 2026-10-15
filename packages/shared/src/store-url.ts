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
 * `url` on the brand's storefront domain, or nothing.
 *
 * Empty whenever the store address is missing or unusable, rather than the
 * input untouched. Handing back the input looks like the forgiving choice and
 * is the one failure this module exists to prevent: the address it would return
 * is the platform host described above, which resolves, renders and gets
 * published. A blank link is visibly unfinished and someone fixes it; a working
 * link to `*.vtexcommercestable.com.br` is nobody's bug until a customer opens
 * it. The brand's `storeUrl` is what makes a catalogue address publishable, so
 * without it there is no publishable address.
 *
 * Also the join for a bare slug: a catalogue API answers with `linkText` rather
 * than an address, and `/mochila-frozen/p` resolved against the store is a link
 * the store itself authored. Shared because both ends need it — the editor when
 * someone picks a product, the generator when a tool reported only the slug.
 */
export function reHome(
  url: string | undefined,
  storeUrl: string | undefined,
): string {
  const raw = (url ?? "").trim();
  if (!raw) return "";

  const base = sanitizeSiteUrl((storeUrl ?? "").trim());
  if (!base) return "";

  try {
    const parsed = new URL(raw, RELATIVE_BASE);
    const rehomed = new URL(base);
    rehomed.pathname = parsed.pathname;
    rehomed.search = parsed.search;
    rehomed.hash = parsed.hash;
    return rehomed.href;
  } catch {
    return "";
  }
}
