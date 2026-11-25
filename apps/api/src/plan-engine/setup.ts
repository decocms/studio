/**
 * O que o cliente tem que dar pra análise sair inteira, lido só do que está
 * gravado (o perfil e as lacunas das análises). `get_ux_store_view` roda a
 * cada 5 s enquanto a análise anda: nada aqui chama rede nem modelo.
 */

import type { GapDetail, SetupKey, SetupNeed, StoreSetup } from "./contract.ts";
import type { SiteProfile, SourceGap } from "./types.ts";

/** Como a tela nomeia a fonte de cada lacuna. */
const GAP_SOURCE: Record<SourceGap["source"], string> = {
  bigquery: "GA4",
  heatmap: "Deco Analytics",
  lake: "VTEX (pedidos)",
  vtex: "VTEX",
  browser: "Página ao vivo",
  benchmark: "Concorrentes",
  studio: "Studio",
  github: "Código",
};

/** A ordem em que o Plan pede as coisas. */
const KEY_ORDER: Record<SetupKey, number> = {
  domain: 0,
  competitors: 1,
  analytics_install: 2,
  bigquery: 3,
  orders: 4,
  repository: 5,
};

export function gapDetail(g: SourceGap): GapDetail {
  return {
    source: g.source,
    owner: g.owner ?? "ours",
    ...(g.key ? { key: g.key } : {}),
    message: `${GAP_SOURCE[g.source]}: ${g.error}`,
  };
}

export function buildSetup(
  profile: SiteProfile | null,
  gaps: readonly SourceGap[],
): StoreSetup {
  if (!profile) {
    return {
      needs: [{ key: "domain", blocking: true, suggested: null }],
      current: { domain: null, competitors: [] },
    };
  }
  const needs: SetupNeed[] = [];
  if (profile.competitors_confirmed_at === null) {
    needs.push({
      key: "competitors",
      blocking: false,
      suggested: profile.competitors,
    });
  }
  const asked = new Set<SetupKey>(needs.map((n) => n.key));
  const fromGaps = gaps
    .flatMap((g) => (g.owner === "customer" && g.key ? [g.key] : []))
    .sort((a, b) => KEY_ORDER[a] - KEY_ORDER[b]);
  for (const key of fromGaps) {
    if (asked.has(key)) continue;
    asked.add(key);
    needs.push({ key, blocking: false });
  }
  return {
    needs,
    current: { domain: profile.domain, competitors: profile.competitors },
  };
}
