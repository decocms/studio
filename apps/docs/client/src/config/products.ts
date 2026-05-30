export interface Product {
  id: string;
  label: string;
  description: string;
  /** Absolute URL. `null` for the current product. */
  href: string | null;
  external: boolean;
}

export const products: readonly Product[] = [
  {
    id: "decocms",
    label: "decocms",
    description: "AI agents & MCP control plane",
    href: null,
    external: false,
  },
  {
    id: "deco-cx",
    label: "deco.cx",
    description: "Storefront platform",
    href: "https://docs.deco.cx",
    external: true,
  },
];

export const CURRENT_PRODUCT_ID = "decocms";
