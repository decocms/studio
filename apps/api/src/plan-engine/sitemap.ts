/**
 * Sitemap as the benchmark's last resort: stores whose home and listings show
 * no recognizable product link usually publish PDPs and categories there.
 * Plain `fetch` (no browser, but from where it runs), with size and request caps.
 */

import { type Fetcher, USER_AGENTS } from "./browser.ts";
import { sameStore } from "./domain-check.ts";
import { classifyPath } from "./store-discovery.ts";

const FETCH_TIMEOUT_MS = 6_000;
/** A large store's sitemap exceeds 10 MB; the first URLs are enough. */
const MAX_BYTES = 1_500_000;
/** The limits a fetcher built for `sitemapCandidates` should read with. */
export const SITEMAP_FETCH = {
  maxBytes: MAX_BYTES,
  timeoutMs: FETCH_TIMEOUT_MS,
};
/** robots + up to 2 top-level sitemaps + up to 2 children of an index. */
const MAX_FETCHES = 5;
const MAX_CANDIDATES = 6;

export type SitemapWant = "pdp" | "listing";

/** The `Sitemap:` lines of robots.txt. */
export function sitemapsFromRobots(robots: string): string[] {
  const out: string[] = [];
  for (const line of robots.split(/\r?\n/)) {
    const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (m?.[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** A sitemap's `<loc>`s; `index` = it is an index of other sitemaps. */
export function parseSitemap(xml: string): {
  index: boolean;
  locs: string[];
} {
  const locs: string[] = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  for (const m of xml.matchAll(re)) {
    if (m[1]) locs.push(m[1].replace(/&amp;/g, "&"));
    if (locs.length >= 5_000) break;
  }
  return { index: /<sitemapindex[\s>]/i.test(xml), locs };
}

/** Index child whose name says what it holds. */
const CHILD_HINT: Record<SitemapWant, RegExp> = {
  pdp: /product|produto/i,
  listing: /categor|departa|collection|colec|department|brand|marca/i,
};

/** The index children to follow: name-hinted ones first; with none, the first ones (generic index, `sitemap-1.xml`). */
export function pickChildSitemaps(
  locs: readonly string[],
  want: SitemapWant,
  max: number,
): { url: string; hinted: boolean }[] {
  const usable = locs.filter((l) => !/\.gz($|\?)/i.test(l));
  const hinted = usable.filter((l) => CHILD_HINT[want].test(l));
  const other = want === "pdp" ? CHILD_HINT.listing : CHILD_HINT.pdp;
  const rest = usable.filter(
    (l) => !CHILD_HINT[want].test(l) && !other.test(l),
  );
  return [
    ...hinted.map((url) => ({ url, hinted: true })),
    ...rest.map((url) => ({ url, hinted: false })),
  ].slice(0, max);
}

/** The URLs in a sitemap list that are useful: the store's own and PDP-like (or listing-like); in a product-named sitemap any store URL counts since the PDP is confirmed on open. */
export function pickPageUrls(
  locs: readonly string[],
  host: string,
  want: SitemapWant,
  hinted: boolean,
): string[] {
  const out: string[] = [];
  for (const loc of locs) {
    let url: URL;
    try {
      url = new URL(loc);
    } catch {
      continue;
    }
    if (!sameStore(url.hostname, host)) continue;
    const kind = classifyPath(url.pathname);
    const fits =
      want === "pdp"
        ? kind === "pdp" || kind === "maybe" || (hinted && kind === "listing")
        : kind === "listing";
    if (!fits) continue;
    const key = `${url.origin}${url.pathname}`;
    if (!out.includes(key)) out.push(key);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** The body up to `max` bytes; the rest is discarded without downloading. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, max));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, all.length - offset);
    all.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

/** Candidates from the store's sitemap: robots.txt `Sitemap:`, else `/sitemap.xml`; an index is followed one level. Never throws: no sitemap, empty list. */
export async function sitemapCandidates(
  origin: string,
  want: SitemapWant,
  fetcher: Fetcher = fetch,
): Promise<string[]> {
  let fetches = 0;
  const get = async (url: string): Promise<string | null> => {
    if (fetches >= MAX_FETCHES) return null;
    fetches++;
    try {
      const res = await fetcher(url, {
        redirect: "follow",
        headers: { "user-agent": USER_AGENTS.desktop },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        return null;
      }
      return await readCapped(res, MAX_BYTES);
    } catch {
      return null;
    }
  };

  const host = new URL(origin).hostname;
  const robots = await get(`${origin}/robots.txt`);
  // robots.txt may point to another host that does not list this store's pages; the store's own `/sitemap.xml` is always the fallback.
  const listed = (robots ? sitemapsFromRobots(robots) : []).filter((u) => {
    try {
      return sameStore(new URL(u).hostname, host);
    } catch {
      return false;
    }
  });
  const roots = [...new Set([...listed, `${origin}/sitemap.xml`])]
    .filter((u) => !/\.gz($|\?)/i.test(u))
    .slice(0, 2);

  const out: string[] = [];
  const add = (urls: string[]) => {
    for (const u of urls) if (!out.includes(u)) out.push(u);
  };
  for (const root of roots) {
    if (out.length >= MAX_CANDIDATES) break;
    const xml = await get(root);
    if (!xml) continue;
    const parsed = parseSitemap(xml);
    if (!parsed.index) {
      add(pickPageUrls(parsed.locs, host, want, CHILD_HINT[want].test(root)));
      continue;
    }
    for (const child of pickChildSitemaps(parsed.locs, want, 2)) {
      if (out.length >= MAX_CANDIDATES) break;
      const inner = await get(child.url);
      if (!inner) continue;
      add(pickPageUrls(parseSitemap(inner).locs, host, want, child.hinted));
    }
  }
  return out.slice(0, MAX_CANDIDATES);
}
