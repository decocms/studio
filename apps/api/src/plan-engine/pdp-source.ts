/**
 * Qual PDP abrir quando os dados da rodada não deram um produto (sem GA4 ou
 * sem VTEX).
 *
 * Antes, isso era "varre a home atrás de um link com cara de PDP" — e há loja
 * cuja home não tem link que case com o padrão, então dava "não achei uma PDP
 * na home da loja". Uma PDP de verdade a gente já tem nos dados:
 *
 *   1. a PDP principal do último diagnóstico concluído DESTE domínio, da
 *      mesma org;
 *   2. a busca do catálogo VTEX;
 *   3. só então a home (pdpCandidates), pra loja que não tem nada disso.
 */

import type { PlanEngineStorage } from "@/storage/plan-engine";
import { pdpCandidates } from "./benchmark.ts";
import { openPage } from "./browser.ts";
import { isProductPageInPage } from "./page-scripts.ts";
import type { BrowserPage, BrowserPort } from "./ports.ts";
import { type VtexAccess, vtexCatalogSearch } from "./vtex.ts";

/** URL de PDP a partir do slug da VTEX — o mesmo formato de collect.ts. */
function pdpUrl(domain: string, linkText: string): string {
  return `https://${domain}/${linkText}/p`;
}

const sameHost = (url: string, domain: string) => {
  try {
    const bare = (h: string) => h.replace(/^www\./, "");
    return bare(new URL(url).hostname) === bare(domain);
  } catch {
    return false;
  }
};

/** As candidatas dos dados, na ordem de confiança, sem repetir. */
export async function candidatePdpUrls(opts: {
  store: Pick<PlanEngineStorage, "listDiagnoses" | "getDiagnosis">;
  orgId: string;
  domain: string;
  vtex: VtexAccess | null;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const out: string[] = [];
  // Sempre no host do perfil: uma URL antiga no apex passa por um redirect que derruba o `?html=1`.
  const push = (url: string | null | undefined) => {
    if (!url || !sameHost(url, opts.domain)) return;
    const u = new URL(url);
    u.hostname = opts.domain;
    if (!out.includes(u.href)) out.push(u.href);
  };

  const done = (await opts.store.listDiagnoses(opts.orgId, 10)).find(
    (d) => d.status === "done" && d.domain === opts.domain,
  );
  if (done) {
    push(
      (await opts.store.getDiagnosis(opts.orgId, done.id))?.evidence
        ?.captures[0]?.url,
    );
  }

  if (opts.vtex && out.length < 3) {
    try {
      for (const p of await vtexCatalogSearch(
        opts.vtex,
        "",
        { to: 4 },
        opts.fetchImpl,
      )) {
        if (p.linkText) push(pdpUrl(opts.domain, String(p.linkText)));
      }
    } catch {
      // VTEX fora: a home ainda resolve
    }
  }
  return out;
}

/**
 * A primeira candidata que abre como PDP de verdade (JSON-LD Product ou
 * og:type product); sem nenhuma, as candidatas da home. NULL = não há.
 */
export async function resolvePdpUrl(
  browser: BrowserPort,
  domain: string,
  candidates: readonly string[],
): Promise<string | null> {
  const isPdp = async (url: string) => {
    let page: BrowserPage | null = null;
    try {
      page = await openPage(browser, url, "mobile");
      return await page.evaluate(isProductPageInPage);
    } catch {
      return false;
    } finally {
      await page?.close().catch(() => {});
    }
  };
  for (const url of candidates.slice(0, 3)) {
    if (await isPdp(url)) return url;
  }
  let tries = 0;
  for await (const link of pdpCandidates(browser, `https://${domain}/`, {
    ownStore: true,
  })) {
    if (await isPdp(link)) return link;
    if (++tries >= 3) break;
  }
  return null;
}
