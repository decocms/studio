/**
 * What the customer must provide for a complete analysis, read only from what
 * is stored. It runs every 5 s while the analysis runs, so nothing here may
 * call the network or a model.
 */

import type { GapDetail, SetupKey, SetupNeed, StoreSetup } from "./contract.ts";
import type { SiteProfile, SourceGap } from "./types.ts";

/** How the screen names each gap's source. */
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

/** The order in which Plan asks for things. */
const KEY_ORDER: Record<SetupKey, number> = {
  domain: 0,
  ai_provider: 1,
  competitors: 2,
  analytics_install: 3,
  bigquery: 4,
  orders: 5,
  repository: 6,
};

/** What a run refused for lack of a model asks for. */
export const AI_PROVIDER_NEED: SetupNeed = {
  key: "ai_provider",
  blocking: true,
};

export function gapDetail(g: SourceGap): GapDetail {
  return {
    source: g.source,
    owner: g.owner ?? "ours",
    ...(g.key ? { key: g.key } : {}),
    message: `${GAP_SOURCE[g.source]}: ${g.error}`,
  };
}

/** `hasModel: false` = the org has no AI model; read live, so a stale gap never asks for it. */
export function buildSetup(
  profile: SiteProfile | null,
  gaps: readonly SourceGap[],
  hasModel = true,
): StoreSetup {
  const aiNeed = hasModel ? [] : [AI_PROVIDER_NEED];
  if (!profile) {
    return {
      needs: [{ key: "domain", blocking: true, suggested: null }, ...aiNeed],
      current: { domain: null, competitors: [] },
    };
  }
  const needs: SetupNeed[] = [...aiNeed];
  if (profile.competitors_confirmed_at === null) {
    needs.push({
      key: "competitors",
      blocking: false,
      suggested: profile.competitors,
    });
  }
  const asked = new Set<SetupKey>(["ai_provider", ...needs.map((n) => n.key)]);
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
