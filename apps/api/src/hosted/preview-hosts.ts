/**
 * The hosts a hosted Blocks v8 site shows drafts on: written by Studio as
 * `previewHosts` into the release metadata on delivery.decocms.com
 * (latest.json and each revisions/<sha>.json), which the site's remote loader
 * trusts. `readVersion` honours a `?__draft=` link or the draft cookie only on
 * a request whose host is in that list. Sites declare nothing.
 *
 * Where the hosts come from, all of them addresses Studio already knows:
 *
 *   - the project's preview server (`metadata.previewServerUrl`, the address
 *     the site editor's frame and preview links open drafts on);
 *   - the site's deco.cx domains (the `{site}.deco.site` host and any custom
 *     domain), when this Studio is linked to deco.cx.
 *
 * A v8 site never previews a hosted draft on a tunnel or on Localhost (a
 * connected `deco serve` reads and writes the files on disk), so neither is
 * listed unless it is the preview server itself.
 *
 * Each entry is a URL's `host`: the lowercase hostname (punycode), with the
 * port only when the address names one, so it is an exact host pattern in
 * `@decocms/blocks`' format (no wildcards). The list is sorted and has no
 * duplicates, so the same addresses always write the same bytes.
 */

import {
  productionUrlFromDomain,
  resolvePreviewServerUrl,
} from "@decocms/shared/deco-site-production-url";
import { getDecoSupabaseConfig, supabaseGet } from "@/deco-legacy/supabase";

/** A hostname a host pattern can name: DNS labels, or an IPv6 address in brackets. */
const HOSTNAME_RE =
  /^(\[[0-9a-f:.]+\]|[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*)$/;

/**
 * An address's host (`name` or `name:port`, without a trailing dot), or null
 * when it isn't an http(s) address.
 */
function hostOf(address: string | null | undefined): string | null {
  const raw = address?.trim() ?? "";
  // Another scheme isn't a site address (`productionUrlFromDomain` would read
  // `ftp://x` as the host `ftp`).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
    return null;
  }
  const url = productionUrlFromDomain(raw);
  if (!url) return null;
  try {
    const { hostname, port } = new URL(url);
    const name = hostname.replace(/\.$/, "");
    if (!HOSTNAME_RE.test(name)) return null;
    return port === "" ? name : `${name}:${port}`;
  } catch {
    return null;
  }
}

/** Sorted, deduplicated hosts of `addresses`; anything unreadable is left out. */
export function previewHostsOf(
  addresses: Iterable<string | null | undefined>,
): string[] {
  const hosts = new Set<string>();
  for (const address of addresses) {
    const host = hostOf(address);
    if (host) hosts.add(host);
  }
  return [...hosts].sort();
}

/** The site's deco.cx domains, as deco.cx lists them. */
export type SiteDomainsReader = (site: string) => Promise<string[]>;

/** The deco.cx domains of `site`; none when this Studio isn't linked to deco.cx. */
const decoSiteDomains: SiteDomainsReader = async (site) => {
  const config = getDecoSupabaseConfig();
  if (!config) return [];
  const rows = await supabaseGet<{
    domains: { domain: string }[] | null;
  }>(
    config.supabaseUrl,
    config.serviceKey,
    `sites?name=eq.${encodeURIComponent(site)}&select=domains&limit=1`,
  );
  return (rows[0]?.domains ?? [])
    .map((d) => d?.domain)
    .filter((d): d is string => typeof d === "string");
};

/**
 * The preview hosts of a project's site. Reading the deco.cx domains never
 * fails a Publish: when it can't be read, the list is the preview server's
 * host alone (logged), and the next Publish writes the whole list again.
 */
export async function sitePreviewHosts(input: {
  site: string;
  metadata: Record<string, unknown> | null | undefined;
  domains?: SiteDomainsReader;
}): Promise<string[]> {
  const readDomains = input.domains ?? decoSiteDomains;
  const domains = await readDomains(input.site).catch((error: unknown) => {
    console.error("hosted: reading the site's domains failed", {
      site: input.site,
      error: error instanceof Error ? error.message : String(error),
    });
    return [] as string[];
  });
  return previewHostsOf([
    resolvePreviewServerUrl(
      input.metadata as Parameters<typeof resolvePreviewServerUrl>[0],
    ),
    ...domains,
  ]);
}
