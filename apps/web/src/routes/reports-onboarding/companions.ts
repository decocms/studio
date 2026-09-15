export interface CompanionCopy {
  /** Registry item id pointer, e.g. "deco/vtex" — reliable resolution path. */
  registryAppId: string;
  /** Business area this source opens up (e.g. "Funil", "Catálogo") — a scannable
   *  tag oriented to the merchant's business, not our internal check count. */
  area: string;
  /** Primary value line under the card — the revenue outcome connecting reveals.
   *  Kept short so it renders in ~2 lines without truncation. */
  headline: string;
  /** Extra unlock bullet lines. */
  bullets?: string[];
}

// Business-oriented copy: each card names the area of the merchant's operation
// it opens up (area tag) and the revenue outcome it reveals (headline), instead
// of an internal "+N verificações" count that means nothing to a store owner.
// NOTE: wording still open for design review (Figma node 8669-25470).
export const COMMERCE_COMPANION_MCPS: Record<string, CompanionCopy> = {
  vtex: {
    registryAppId: "deco/vtex",
    area: "Catálogo",
    headline: "Rupturas e PDPs que travam suas vendas.",
  },
  shopify: {
    registryAppId: "deco/shopify",
    area: "Catálogo",
    headline: "Pedidos, estoque e catálogo direto da sua Shopify.",
  },
  "google-analytics": {
    registryAppId: "deco/google-analytics",
    area: "Funil",
    headline: "Onde a receita vaza no seu funil.",
  },
  "google-search-console": {
    registryAppId: "deco/google-search-console",
    area: "Busca",
    headline: "O tráfego de busca que você deixa na mesa.",
  },
  github: {
    registryAppId: "deco/mcp-github",
    area: "Engenharia",
    headline: "A saúde da entrega de código por trás da sua loja.",
  },
};
