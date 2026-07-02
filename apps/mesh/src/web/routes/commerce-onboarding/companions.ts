export interface CompanionCopy {
  /** Registry item id pointer, e.g. "deco/vtex" — reliable resolution path. */
  registryAppId: string;
  /** Static "+ N checks" number (editorial). */
  checks: number;
  /** Primary value line under the card. */
  headline: string;
  /** Extra unlock bullet lines. */
  bullets?: string[];
}

// NOTE: copy is placeholder pending final strings from design (Figma node 8669-25470).
export const COMMERCE_COMPANION_MCPS: Record<string, CompanionCopy> = {
  vtex: {
    registryAppId: "deco/vtex",
    checks: 49,
    headline:
      "Rupturas, PDPs incompletas e lacunas de atributos em todos os SKUs",
  },
  "google-analytics": {
    registryAppId: "deco/google-analytics",
    checks: 49,
    headline:
      "Onde a receita vaza entre a visualização do produto e o checkout",
  },
  "google-search-console": {
    registryAppId: "deco/google-search-console",
    checks: 49,
    headline:
      "Lacunas de visibilidade na busca e indexação em todo o seu catálogo",
  },
};
