/**
 * Which PDP to open when the run's data gave no product: the main PDP of this
 * domain's last finished diagnosis, then the VTEX catalog search, then the home.
 */

import type { PlanEngineStorage } from "@/storage/plan-engine";
import { pdpCandidates } from "./benchmark.ts";
import { openPage } from "./browser.ts";
import { isProductPageInPage } from "./page-scripts.ts";
import type { BrowserPage, BrowserPort } from "./ports.ts";
import { type VtexAccess, vtexCatalogSearch } from "./vtex.ts";

/** A PDP URL from a VTEX slug, in collect.ts's format. */
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

/** The data's candidates, most trusted first, without repeats. */
export async function candidatePdpUrls(opts: {
  store: Pick<PlanEngineStorage, "listDiagnoses" | "getDiagnosis">;
  orgId: string;
  domain: string;
  vtex: VtexAccess | null;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const out: string[] = [];
  // Always on the profile's host: an old apex URL redirects and loses `?html=1`.
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
      // VTEX down: the home still resolves
    }
  }
  return out;
}

/**
 * The first candidate that opens as a real PDP (JSON-LD Product or og:type
 * product); otherwise the home's candidates. Null when there is none.
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
