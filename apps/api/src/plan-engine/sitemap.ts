/**
 * Sitemap como último recurso do benchmark: loja cuja home e vitrines não
 * mostram link de produto reconhecível quase sempre publica as PDPs e as
 * categorias no sitemap. `fetch` simples (sem navegador), com teto de tamanho
 * e de pedidos: cada pedido conta no orçamento de subrequests da instância.
 */

import { USER_AGENTS } from "./browser.ts";
import { sameStore } from "./domain-check.ts";
import { classifyPath } from "./store-discovery.ts";

const FETCH_TIMEOUT_MS = 6_000;
/** Sitemap de loja grande passa de 10 MB; as primeiras URLs bastam. */
const MAX_BYTES = 1_500_000;
/** robots + até 2 sitemaps do topo + até 2 filhos de um índice. */
const MAX_FETCHES = 5;
const MAX_CANDIDATES = 6;

export type SitemapWant = "pdp" | "listing";

/** As linhas `Sitemap:` do robots.txt. */
export function sitemapsFromRobots(robots: string): string[] {
  const out: string[] = [];
  for (const line of robots.split(/\r?\n/)) {
    const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (m?.[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** As `<loc>` de um sitemap; `index` = é um índice de outros sitemaps. */
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

/** Filho de índice cujo nome diz o que tem dentro. */
const CHILD_HINT: Record<SitemapWant, RegExp> = {
  pdp: /product|produto/i,
  listing: /categor|departa|collection|colec|department|brand|marca/i,
};

/**
 * Os filhos de um índice a seguir: os que o nome indica primeiro; sem nenhum
 * indicado, os primeiros (índice genérico, `sitemap-1.xml`).
 */
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

/**
 * As URLs de uma lista de sitemap que servem: da loja e com cara de PDP (ou
 * de vitrine). Num sitemap cujo nome já diz "produto", toda URL da loja vale —
 * a PDP é confirmada ao abrir de qualquer jeito.
 */
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

/** O corpo até `max` bytes; o resto é descartado sem baixar. */
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

/**
 * Candidatas do sitemap da loja: `Sitemap:` do robots.txt, senão
 * `/sitemap.xml`; um índice é seguido um nível. Nunca lança: sem sitemap,
 * lista vazia.
 */
export async function sitemapCandidates(
  origin: string,
  want: SitemapWant,
  fetcher: typeof fetch = fetch,
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
  // O robots.txt pode apontar pra outro host (um subdomínio de clube, um
  // CDN): esse não lista as páginas desta loja. O `/sitemap.xml` da própria
  // loja entra sempre como reserva.
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
