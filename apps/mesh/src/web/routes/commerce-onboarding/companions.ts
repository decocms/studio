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
    headline: "Out-of-stock, thin PDPs & attribute gaps across every SKU",
  },
  "google-analytics": {
    registryAppId: "deco/google-analytics",
    checks: 49,
    headline: "Where revenue leaks between product view and checkout",
  },
  "google-search-console": {
    registryAppId: "deco/google-search-console",
    checks: 49,
    headline: "Search visibility & indexing gaps across your catalog",
  },
};
